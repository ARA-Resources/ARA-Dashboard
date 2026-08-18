"""
Modify existing P-Roles PivotTable1 in the MAIN Lateral XLSM.

ONLY touches the P-Roles sheet / PivotTable1.
Does NOT modify Master Sheet values, New Sheet, VBA, or other tabs.

Requirements:
- Rows: Primary Skills → Skill Categorization
- Columns: Job Management Level ordered 8→9→10→11→12 (keep 12 even if empty)
- Value: Count of Job Requisition ID
- Filters: Job Status, Posted, Market Map
- Job Status: all four available; default Active+New+Reopen if Closed remains selectable
- Source: Master Sheet!A1:M{last}
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import traceback
from collections import Counter

XL_DATABASE = 1
XL_ROW_FIELD = 1
XL_COLUMN_FIELD = 2
XL_PAGE_FIELD = 3
XL_COUNT = -4112
XL_TABULAR_ROW = 1
XL_LAYOUT_FORM_TABULAR = 0
XL_REPEAT_LABELS = 1
XL_UP = -4162
XL_MANUAL = -4135
MSO_AUTOMATION_SECURITY_FORCE_DISABLE = 3

ROW_FIELDS = ["Primary Skills", "Skill Categorization"]
COLUMN_FIELD = "Job Management Level"
VALUE_FIELD = "Job Requisition ID"
VALUE_CAPTION = "Count of Job Requisition ID"
PAGE_FIELDS = ["Job Status", "Posted", "Market Map"]
REQUIRED_STATUSES = ["Active", "New", "Closed", "Reopen"]
DEFAULT_VISIBLE_STATUSES = {"Active", "New", "Reopen"}
JML_CANONICAL = [
    "8-Associate Manager",
    "9-Team Lead/Consultant",
    "10-Senior Analyst",
    "11-Analyst",
    "12-Associate",
]


def jml_sort_key(label: str) -> tuple[int, str]:
    m = re.match(r"^(\d+)", str(label).strip())
    return (int(m.group(1)) if m else 10_000, str(label).lower())


def com_call(obj, name: str, *args):
    fn = getattr(obj, name)
    if callable(fn):
        return fn(*args)
    return fn


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def fingerprint_master(master) -> dict:
    used = master.UsedRange
    rows = int(used.Rows.Count)
    cols = int(used.Columns.Count)
    headers = []
    for c in range(1, min(cols, 20) + 1):
        headers.append(str(master.Cells(1, c).Text or "").strip())
    while headers and headers[-1] == "":
        headers.pop()

    last_row = master.Cells(master.Rows.Count, 2).End(XL_UP).Row

    # Fast column reads (avoid per-cell COM for 23k rows).
    def col_values(col_idx: int) -> list[str]:
        if last_row < 2:
            return []
        raw = master.Range(
            master.Cells(2, col_idx), master.Cells(last_row, col_idx)
        ).Value
        if raw is None:
            return []
        if not isinstance(raw, (list, tuple)):
            return [str(raw or "").strip()]
        out: list[str] = []
        for item in raw:
            if isinstance(item, (list, tuple)):
                out.append(str(item[0] or "").strip())
            else:
                out.append(str(item or "").strip())
        return out

    status_vals = col_values(11)
    status_counts: Counter[str] = Counter(
        (v if v else "(blank)") for v in status_vals
    )

    sample_rows = [2, 3, 4, 5, 10, 100, 1000, max(2, last_row // 2), last_row]
    sample = []
    for r in sample_rows:
        if r < 2 or r > last_row:
            continue
        sample.append(
            {
                "row": r,
                "jobReqId": str(master.Cells(r, 2).Text or ""),
                "skillCat": str(master.Cells(r, 5).Text or ""),
                "primarySkills": str(master.Cells(r, 6).Text or ""),
                "jml": str(master.Cells(r, 7).Text or ""),
                "marketMap": str(master.Cells(r, 9).Text or ""),
                "jobStatus": str(master.Cells(r, 11).Text or ""),
                "posted": str(master.Cells(r, 13).Text or ""),
                "jdLen": len(str(master.Cells(r, 4).Value or "")),
            }
        )

    return {
        "usedRows": rows,
        "usedCols": cols,
        "lastDataRowColB": last_row,
        "headers": headers,
        "statusCounts": dict(status_counts),
        "sample": sample,
    }


def list_pivot_item_names(field) -> list[str]:
    names: list[str] = []
    for item in field.PivotItems():
        name = str(item.Name)
        if name.startswith("(") and name.endswith(")"):
            continue
        names.append(name)
    return names


def set_job_status_selection(js, selected: set[str] | None) -> dict:
    """
    selected=None → show All (every real status visible).
    selected=set → those Visible=True, others Visible=False (still in PivotItems).

    Excel requires at least one visible item; show-all first, then hide unwanted.
    """
    try:
        js.EnableMultiplePageItems = True
    except Exception:
        pass
    try:
        # Clear single-page lock if present.
        js.CurrentPage = "(All)"
    except Exception:
        pass

    available = list_pivot_item_names(js)

    # Pass 1: make every real status visible.
    for name in available:
        try:
            js.PivotItems(name).Visible = True
        except Exception:
            pass

    if selected is None:
        return {"available": available, "visible": list(available), "hiddenUnchecked": []}

    # Pass 2: hide statuses not in the selection (Closed remains in PivotItems).
    hidden: list[str] = []
    visible: list[str] = []
    for name in available:
        want = name in selected
        try:
            js.PivotItems(name).Visible = want
            (visible if want else hidden).append(name)
        except Exception:
            # If hide fails, leave as-is and record.
            try:
                if bool(js.PivotItems(name).Visible):
                    visible.append(name)
                else:
                    hidden.append(name)
            except Exception:
                pass
    return {"available": available, "visible": visible, "hiddenUnchecked": hidden}


def read_header_row(p_roles, pt) -> list[str]:
    """Read rendered JML column headers from the pivot body."""
    rng = pt.TableRange1
    start_row = int(rng.Row)
    start_col = int(rng.Column)
    cols = int(rng.Columns.Count)
    # Header with JML labels is typically 1–2 rows into TableRange1.
    headers: list[str] = []
    for r_off in range(0, 3):
        row_vals = []
        for c in range(start_col, start_col + cols):
            row_vals.append(str(p_roles.Cells(start_row + r_off, c).Text or "").strip())
        if any(re.match(r"^\d+-", v) for v in row_vals):
            headers = [v for v in row_vals if v]
            break
    return headers


def grand_total_value(p_roles, pt) -> str:
    last_row = pt.TableRange2.Row + pt.TableRange2.Rows.Count - 1
    last_col = pt.TableRange2.Column + pt.TableRange2.Columns.Count - 1
    return str(p_roles.Cells(last_row, last_col).Text or "")


def parse_number(text: str) -> int:
    s = re.sub(r"[^0-9]", "", str(text or ""))
    return int(s) if s else 0


def modify(path: str) -> dict:
    import pythoncom
    import win32com.client

    pythoncom.CoInitialize()
    excel = None
    wb = None
    notes: list[str] = []
    try:
        excel = win32com.client.DispatchEx("Excel.Application")
        excel.Visible = False
        excel.DisplayAlerts = False
        excel.AskToUpdateLinks = False
        excel.EnableEvents = False
        try:
            excel.AutomationSecurity = MSO_AUTOMATION_SECURITY_FORCE_DISABLE
        except Exception:
            pass

        wb = excel.Workbooks.Open(
            path,
            UpdateLinks=0,
            ReadOnly=False,
            IgnoreReadOnlyRecommended=True,
        )

        sheet_names = [ws.Name for ws in wb.Worksheets]
        if "P-Roles" not in sheet_names:
            raise RuntimeError(f"P-Roles sheet missing. Found: {sheet_names}")
        if "Master Sheet" not in sheet_names:
            raise RuntimeError("Master Sheet missing.")

        p_roles = wb.Worksheets("P-Roles")
        master = wb.Worksheets("Master Sheet")

        master_before = fingerprint_master(master)

        # VBA presence + required macro name in project binary (read-only check later via zip).
        has_vb = False
        try:
            has_vb = bool(wb.HasVBProject)
        except Exception:
            has_vb = True  # XLSM assumed

        # Remove slicers only (they can lock field visibility); keep Master untouched.
        try:
            for sc in list(wb.SlicerCaches):
                try:
                    com_call(sc, "Delete")
                except Exception:
                    pass
        except Exception as exc:
            notes.append(f"slicer cleanup skipped: {exc}")

        while p_roles.PivotTables().Count > 0:
            com_call(p_roles.PivotTables(1).TableRange2, "Clear")
        com_call(p_roles.Cells, "Clear")

        last_row = int(master.Cells(master.Rows.Count, 2).End(XL_UP).Row)
        if last_row < 2:
            raise RuntimeError("Master Sheet has no data rows.")
        last_col = 13  # A:M only — do not expand to N:R
        source = f"'Master Sheet'!R1C1:R{last_row}C{last_col}"
        source_a1 = f"'Master Sheet'!A1:M{last_row}"

        cache = wb.PivotCaches().Create(SourceType=XL_DATABASE, SourceData=source)
        pt = cache.CreatePivotTable(
            TableDestination=p_roles.Range("A5"),
            TableName="PivotTable1",
        )

        missing = []
        for name in [*ROW_FIELDS, COLUMN_FIELD, VALUE_FIELD, *PAGE_FIELDS]:
            try:
                pt.PivotFields(name)
            except Exception:
                missing.append(name)
        if missing:
            raise RuntimeError("Missing fields: " + ", ".join(missing))

        for name in reversed(PAGE_FIELDS):
            pt.PivotFields(name).Orientation = XL_PAGE_FIELD

        for name in ROW_FIELDS:
            pt.PivotFields(name).Orientation = XL_ROW_FIELD

        # Value before column axis so JML stays on columns.
        pt.AddDataField(pt.PivotFields(VALUE_FIELD), VALUE_CAPTION, XL_COUNT)
        pt.PivotFields(COLUMN_FIELD).Orientation = XL_COLUMN_FIELD

        pt.RowAxisLayout(XL_TABULAR_ROW)
        try:
            pt.RepeatAllLabels(XL_REPEAT_LABELS)
        except Exception as exc:
            notes.append(f"RepeatAllLabels skipped: {exc}")

        false_subtotals = tuple([False] * 12)
        for name in ROW_FIELDS:
            field = pt.PivotFields(name)
            try:
                field.LayoutForm = XL_LAYOUT_FORM_TABULAR
            except Exception as exc:
                notes.append(f"{name} LayoutForm skipped: {exc}")
            try:
                field.LayoutCompactRow = False
            except Exception as exc:
                notes.append(f"{name} LayoutCompactRow skipped: {exc}")
            try:
                field.Subtotals = false_subtotals
            except Exception as exc:
                notes.append(f"{name} subtotals skipped: {exc}")

        pt.RowGrand = True
        pt.ColumnGrand = True

        # Show empty JML columns (keep 12 even if no rows under current filters).
        try:
            pt.ColumnGrand = True
            pt.ShowEmptyColItems = True
        except Exception as e:
            notes.append(f"ShowEmptyColItems skipped: {e}")
        # Numeric JML column order: 8 < 9 < 10 < 11 < 12 (never alphabetical).
        # Must be re-applied AFTER every RefreshTable — refresh can restore Ascending.
        def apply_jml_numeric_order(note_prefix: str = "JML") -> list[str]:
            field = pt.PivotFields(COLUMN_FIELD)
            try:
                field.ShowAllItems = True
            except Exception as e:
                notes.append(f"{note_prefix} ShowAllItems skipped: {e}")
            try:
                field.AutoSort(XL_MANUAL, COLUMN_FIELD)
            except Exception as e:
                notes.append(f"{note_prefix} AutoSort manual skipped: {e}")

            labels = list_pivot_item_names(field)
            ordered_local: list[str] = []
            for canon in JML_CANONICAL:
                if canon in labels and canon not in ordered_local:
                    ordered_local.append(canon)
            for name in sorted(labels, key=jml_sort_key):
                if name not in ordered_local:
                    ordered_local.append(name)
            for index, name in enumerate(ordered_local, start=1):
                try:
                    item = field.PivotItems(name)
                    item.Visible = True
                    item.Position = index
                except Exception as e:
                    notes.append(f"{note_prefix} position '{name}' skipped: {e}")
            return ordered_local

        ordered = apply_jml_numeric_order("JML-setup")

        # Posted / Market Map: all available values visible.
        for fname in ["Posted", "Market Map"]:
            field = pt.PivotFields(fname)
            try:
                field.EnableMultiplePageItems = True
            except Exception:
                pass
            for item in field.PivotItems():
                name = str(item.Name)
                if name.startswith("("):
                    continue
                try:
                    item.Visible = True
                except Exception as e:
                    notes.append(f"{fname} '{name}' visible skipped: {e}")

        js = pt.PivotFields("Job Status")
        available_statuses = list_pivot_item_names(js)
        missing_statuses = [s for s in REQUIRED_STATUSES if s not in available_statuses]
        if missing_statuses:
            raise RuntimeError(
                f"Job Status pivot items missing: {missing_statuses}; available={available_statuses}"
            )

        # Default: Active+New+Reopen selected; Closed unchecked but still in PivotItems.
        default_selection = set_job_status_selection(js, DEFAULT_VISIBLE_STATUSES)
        closed_available = "Closed" in default_selection["available"]
        default_mode = "Active+New+Reopen"
        if not closed_available:
            # Fallback — should not happen.
            default_selection = set_job_status_selection(js, None)
            default_mode = "All"
            notes.append("Closed missing from PivotItems; default set to All.")

        com_call(pt, "RefreshTable")
        ordered = apply_jml_numeric_order("JML-after-refresh")
        try:
            excel.CalculateFullRebuild()
        except Exception:
            try:
                excel.CalculateFull()
            except Exception as e:
                notes.append(f"CalculateFull skipped: {e}")

        # --- Validation: each Job Status separately ---
        status_tests = {}
        master_status_counts = master_before["statusCounts"]
        for status in REQUIRED_STATUSES:
            set_job_status_selection(js, {status})
            com_call(pt, "RefreshTable")
            apply_jml_numeric_order(f"JML-{status}")
            gt = grand_total_value(p_roles, pt)
            expected = int(master_status_counts.get(status, 0))
            got = parse_number(gt)
            status_tests[status] = {
                "grandTotal": gt,
                "grandTotalNum": got,
                "masterCount": expected,
                "match": got == expected,
            }
            if got != expected:
                notes.append(
                    f"STATUS TEST {status}: pivot={got} master={expected} (may differ if blank JR/JML rows)"
                )

        # All statuses
        set_job_status_selection(js, None)
        com_call(pt, "RefreshTable")
        apply_jml_numeric_order("JML-All")
        gt_all = grand_total_value(p_roles, pt)
        expected_all = sum(int(master_status_counts.get(s, 0)) for s in REQUIRED_STATUSES)
        status_tests["All"] = {
            "grandTotal": gt_all,
            "grandTotalNum": parse_number(gt_all),
            "masterCount": expected_all,
            "match": parse_number(gt_all) == expected_all,
        }

        # Restore default selection + final numeric JML order (critical after refreshes).
        if default_mode == "All":
            default_selection = set_job_status_selection(js, None)
        else:
            default_selection = set_job_status_selection(js, DEFAULT_VISIBLE_STATUSES)
        com_call(pt, "RefreshTable")
        ordered = apply_jml_numeric_order("JML-final")
        # Force one more layout calc without another cache refresh that could resort.
        try:
            excel.Calculate()
        except Exception:
            pass

        rendered_headers = read_header_row(p_roles, pt)
        jml_rendered = [h for h in rendered_headers if re.match(r"^\d+-", h)]
        jml_field = pt.PivotFields(COLUMN_FIELD)
        jml_ok = jml_rendered[:5] == JML_CANONICAL[: len(jml_rendered)] and (
            "12-Associate" in list_pivot_item_names(jml_field)
        )
        # Stronger check: first five numeric headers if present must be 8..12 order
        if len(jml_rendered) >= 4:
            prefixes = [int(re.match(r"^(\d+)", h).group(1)) for h in jml_rendered if re.match(r"^(\d+)", h)]
            jml_ok = prefixes == sorted(prefixes) and prefixes[:4] == [8, 9, 10, 11]
        if jml_rendered[:5] != JML_CANONICAL[: len(jml_rendered[:5])]:
            notes.append(
                f"JML rendered order after final apply: {jml_rendered} (expected {JML_CANONICAL})"
            )
            # Fail hard if alphabetical — do not upload a broken order.
            if jml_rendered and jml_rendered[0].startswith("10"):
                raise RuntimeError(
                    f"JML still alphabetical after fix: {jml_rendered}"
                )

        # Source check via PivotCache
        try:
            src_data = str(pt.PivotCache().SourceData)
        except Exception:
            src_data = source

        master_after = fingerprint_master(master)
        if master_before != master_after:
            # Compare ignoring nothing — fail hard if Master changed.
            raise RuntimeError(
                "Master Sheet fingerprint changed during P-Roles modification — aborting save."
            )

        sample = []
        for r in range(1, 10):
            sample.append([str(p_roles.Cells(r, c).Text or "") for c in range(1, 9)])

        com_call(wb, "Save")

        return {
            "ok": True,
            "excelVersion": str(excel.Version),
            "pivotName": pt.Name,
            "sourceR1C1": source,
            "sourceA1": source_a1,
            "sourceData": src_data,
            "rowFields": ROW_FIELDS,
            "columnField": COLUMN_FIELD,
            "valueField": VALUE_FIELD,
            "valueCaption": VALUE_CAPTION,
            "filters": PAGE_FIELDS,
            "jobStatusAvailable": default_selection["available"],
            "jobStatusDefaultVisible": default_selection["visible"],
            "jobStatusDefaultUnchecked": default_selection["hiddenUnchecked"],
            "jobStatusDefaultMode": default_mode,
            "closedAvailable": "Closed" in default_selection["available"],
            "closedCurrentlySelected": "Closed" in default_selection["visible"],
            "jmlOrderPivotItems": ordered,
            "jmlRenderedHeaders": jml_rendered,
            "jmlOrderOk": jml_ok,
            "level12InPivotItems": "12-Associate" in list_pivot_item_names(jml_field),
            "grandTotalDefault": grand_total_value(p_roles, pt),
            "statusTests": status_tests,
            "masterBefore": {
                "usedRows": master_before["usedRows"],
                "usedCols": master_before["usedCols"],
                "lastDataRowColB": master_before["lastDataRowColB"],
                "headers": master_before["headers"],
                "statusCounts": master_before["statusCounts"],
            },
            "masterAfter": {
                "usedRows": master_after["usedRows"],
                "usedCols": master_after["usedCols"],
                "lastDataRowColB": master_after["lastDataRowColB"],
                "headers": master_after["headers"],
                "statusCounts": master_after["statusCounts"],
            },
            "masterUnchanged": master_before == master_after,
            "hasVbProject": has_vb,
            "sampleA1H9": sample,
            "notes": notes,
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": str(exc),
            "trace": traceback.format_exc(),
            "notes": notes,
        }
    finally:
        try:
            if wb is not None:
                wb.Close(SaveChanges=False)
        except Exception:
            pass
        try:
            if excel is not None:
                excel.Quit()
        except Exception:
            pass
        try:
            pythoncom.CoUninitialize()
        except Exception:
            pass


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "workbook path required"}))
        sys.exit(1)
    print(json.dumps(modify(sys.argv[1]), indent=2))
