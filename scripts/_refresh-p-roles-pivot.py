"""
Refresh the existing P-Roles PivotTable on a Lateral Master XLSM.

Discovery:
  P-Roles worksheet → exactly one PivotTable → use that object
  (COM Name may be "P-Roles" or "PivotTable1"; OOXML filename is unrelated)

READ-ONLY vs Master Sheet — only updates pivot cache source + refresh.
Does NOT delete/recreate the PivotTable, modify Master/New/Posted data,
or change Job Status / Market Map filter selections.

Requires Windows + Excel + pywin32.
"""
from __future__ import annotations

import json
import re
import sys
import traceback

XL_UP = -4162
XL_MANUAL = -4135
XL_ROW_FIELD = 1
XL_COLUMN_FIELD = 2
XL_PAGE_FIELD = 3
MSO_AUTOMATION_SECURITY_FORCE_DISABLE = 3

ROW_FIELDS = ["Primary Skills", "Skill Categorization"]
COLUMN_FIELD = "Job Management Level"
VALUE_FIELD = "Job Requisition ID"
VALUE_CAPTION = "Count of Job Requisition ID"
PAGE_FIELDS = ["Job Status", "Posted", "Market Map"]
JML_CANONICAL = [
    "8-Associate Manager",
    "9-Team Lead/Consultant",
    "10-Senior Analyst",
    "11-Analyst",
    "12-Associate",
]
MASTER_SOURCE_LAST_COL = 13  # A:M includes Posted (column M)


def jml_sort_key(label: str) -> tuple[int, str]:
    m = re.match(r"^(\d+)", str(label).strip())
    return (int(m.group(1)) if m else 10_000, str(label).lower())


def com_call(obj, name: str, *args):
    fn = getattr(obj, name)
    if callable(fn):
        return fn(*args)
    return fn


def list_pivot_item_names(field) -> list[str]:
    names: list[str] = []
    for item in field.PivotItems():
        name = str(item.Name)
        if name.startswith("("):
            continue
        names.append(name)
    return names


def capture_visible_items(field) -> set[str]:
    visible: set[str] = set()
    for item in field.PivotItems():
        name = str(item.Name)
        if name.startswith("("):
            continue
        try:
            if item.Visible:
                visible.add(name)
        except Exception:
            pass
    return visible


def restore_visible_items(field, visible: set[str]) -> None:
    for item in field.PivotItems():
        name = str(item.Name)
        if name.startswith("("):
            continue
        try:
            item.Visible = name in visible
        except Exception:
            pass


def show_all_page_items(field) -> list[str]:
    names: list[str] = []
    for item in field.PivotItems():
        name = str(item.Name)
        if name.startswith("("):
            continue
        names.append(name)
        try:
            item.Visible = True
        except Exception:
            pass
    return names


def collect_data_field_names(pt) -> list[str]:
    names: list[str] = []
    for df in pt.DataFields:
        names.append(str(df.Name))
    return names


def validate_p_roles_pivot_structure(pt) -> None:
    """STOP before refresh if this is not the expected P-Roles pivot."""
    problems: list[str] = []

    for name in ROW_FIELDS:
        try:
            orientation = int(pt.PivotFields(name).Orientation)
        except Exception as exc:
            problems.append(f"Missing row field '{name}' ({exc})")
            continue
        if orientation != XL_ROW_FIELD:
            problems.append(
                f"Row field '{name}' orientation={orientation} (expected {XL_ROW_FIELD})"
            )

    try:
        col_orientation = int(pt.PivotFields(COLUMN_FIELD).Orientation)
        if col_orientation != XL_COLUMN_FIELD:
            problems.append(
                f"Column field '{COLUMN_FIELD}' orientation={col_orientation} "
                f"(expected {XL_COLUMN_FIELD})"
            )
    except Exception as exc:
        problems.append(f"Missing column field '{COLUMN_FIELD}' ({exc})")

    for name in PAGE_FIELDS:
        try:
            orientation = int(pt.PivotFields(name).Orientation)
        except Exception as exc:
            problems.append(f"Missing report filter '{name}' ({exc})")
            continue
        if orientation != XL_PAGE_FIELD:
            problems.append(
                f"Report filter '{name}' orientation={orientation} (expected {XL_PAGE_FIELD})"
            )

    data_fields = collect_data_field_names(pt)
    has_jr_count = any(
        VALUE_CAPTION in n or VALUE_FIELD in n for n in data_fields
    )
    has_jml_count = any("Job Management Level" in n for n in data_fields)
    if has_jml_count and not has_jr_count:
        problems.append(
            f"Value field must be '{VALUE_CAPTION}'; found {data_fields}. "
            "Refusing to use Count of Job Management Level."
        )
    elif not has_jr_count:
        problems.append(
            f"Value field must be '{VALUE_CAPTION}'; found {data_fields or '(none)'}."
        )

    if problems:
        raise RuntimeError(
            "P-Roles PivotTable structure validation failed. Refresh was not performed. "
            + " | ".join(problems)
        )


def fingerprint_master(master) -> dict:
    last_row = int(master.Cells(master.Rows.Count, 2).End(XL_UP).Row)

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

    headers = []
    for c in range(1, 20):
        headers.append(str(master.Cells(1, c).Text or "").strip())
    while headers and headers[-1] == "":
        headers.pop()

    return {
        "lastDataRowColB": last_row,
        "headers": headers,
        "statusValues": col_values(11),
        "postedValues": col_values(13),
        "jobReqIds": col_values(2),
    }


def apply_jml_numeric_order(pt, notes: list[str], prefix: str = "JML") -> list[str]:
    field = pt.PivotFields(COLUMN_FIELD)
    try:
        field.ShowAllItems = True
    except Exception as exc:
        notes.append(f"{prefix} ShowAllItems skipped: {exc}")
    try:
        field.AutoSort(XL_MANUAL, COLUMN_FIELD)
    except Exception as exc:
        notes.append(f"{prefix} AutoSort manual skipped: {exc}")

    labels = list_pivot_item_names(field)
    ordered: list[str] = []
    for canon in JML_CANONICAL:
        if canon in labels and canon not in ordered:
            ordered.append(canon)
    for name in sorted(labels, key=jml_sort_key):
        if name not in ordered:
            ordered.append(name)
    for index, name in enumerate(ordered, start=1):
        try:
            item = field.PivotItems(name)
            item.Visible = True
            item.Position = index
        except Exception as exc:
            notes.append(f"{prefix} position '{name}' skipped: {exc}")
    return ordered


def read_header_row(p_roles, pt) -> list[str]:
    try:
        start_col = int(pt.TableRange2.Column)
        end_col = start_col + int(pt.TableRange2.Columns.Count) - 1
        start_row = int(pt.TableRange2.Row)
        headers = []
        for c in range(start_col, end_col + 1):
            headers.append(str(p_roles.Cells(start_row, c).Text or "").strip())
        return [h for h in headers if h]
    except Exception:
        return []


def refresh(path: str) -> dict:
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
            raise RuntimeError(f'P-Roles sheet missing. Found: {sheet_names}')
        if "Master Sheet" not in sheet_names:
            raise RuntimeError("Master Sheet missing — cannot refresh P-Roles source.")

        p_roles = wb.Worksheets("P-Roles")
        master = wb.Worksheets("Master Sheet")

        pivot_count = int(p_roles.PivotTables().Count)
        if pivot_count != 1:
            raise RuntimeError(
                f"P-Roles must contain exactly one PivotTable (found {pivot_count})."
            )

        pt = p_roles.PivotTables(1)
        pivot_name = str(pt.Name)
        notes.append(
            f'Using the only P-Roles PivotTable (COM Name="{pivot_name}"; count=1).'
        )

        validate_p_roles_pivot_structure(pt)

        master_before = fingerprint_master(master)
        last_row = int(master_before["lastDataRowColB"])
        if last_row < 2:
            raise RuntimeError("Master Sheet has no data rows for P-Roles source.")

        source = f"'Master Sheet'!R1C1:R{last_row}C{MASTER_SOURCE_LAST_COL}"
        source_a1 = f"'Master Sheet'!A1:M{last_row}"

        # Preserve existing page-filter selections (Job Status / Market Map).
        job_status_visible = capture_visible_items(pt.PivotFields("Job Status"))
        market_map_visible = capture_visible_items(pt.PivotFields("Market Map"))

        cache = pt.PivotCache()
        try:
            cache.SourceData = source
        except Exception as exc:
            notes.append(f"SourceData assign skipped: {exc}; trying ChangePivotCache")
            new_cache = wb.PivotCaches().Create(SourceType=1, SourceData=source)
            pt.ChangePivotCache(new_cache)

        com_call(pt, "RefreshTable")

        if int(p_roles.PivotTables().Count) != 1:
            raise RuntimeError(
                "P-Roles PivotTables.Count changed during refresh. No extra pivot is allowed."
            )

        # Posted filter must reflect latest Master Column M (Yes / -).
        posted_items = show_all_page_items(pt.PivotFields("Posted"))
        if "Yes" not in posted_items or "-" not in posted_items:
            raise RuntimeError(
                f"Posted filter must contain '-' and 'Yes' after refresh; found {posted_items}."
            )

        restore_visible_items(pt.PivotFields("Job Status"), job_status_visible)
        restore_visible_items(pt.PivotFields("Market Map"), market_map_visible)

        ordered = apply_jml_numeric_order(pt, notes, "JML-after-refresh")
        canonical_present = [n for n in JML_CANONICAL if n in ordered]
        if canonical_present != [
            n for n in ordered if n in JML_CANONICAL
        ]:
            raise RuntimeError(
                f"JML order must be 8→9→10→11→12; got {ordered}."
            )

        try:
            excel.Calculate()
        except Exception:
            try:
                excel.CalculateFull()
            except Exception as exc:
                notes.append(f"Calculate skipped: {exc}")

        validate_p_roles_pivot_structure(pt)

        data_fields = collect_data_field_names(pt)

        jml_rendered = [h for h in read_header_row(p_roles, pt) if re.match(r"^\d+-", h)]
        jml_prefixes = [
            int(re.match(r"^(\d+)", h).group(1))
            for h in jml_rendered
            if re.match(r"^(\d+)", h)
        ]
        jml_ok = jml_prefixes == sorted(jml_prefixes)
        if len(jml_prefixes) >= 4 and jml_prefixes[:4] != [8, 9, 10, 11]:
            jml_ok = False
            notes.append(f"JML rendered order: {jml_rendered}")

        master_after = fingerprint_master(master)
        if master_before["headers"] != master_after["headers"]:
            raise RuntimeError("Master Sheet headers changed during P-Roles refresh.")
        if master_before["lastDataRowColB"] != master_after["lastDataRowColB"]:
            raise RuntimeError("Master Sheet row count changed during P-Roles refresh.")
        if master_before["statusValues"] != master_after["statusValues"]:
            raise RuntimeError(
                "Master Sheet Column K / Job Status changed during P-Roles refresh."
            )
        if master_before["postedValues"] != master_after["postedValues"]:
            raise RuntimeError(
                "Master Sheet Column M / Posted changed during P-Roles refresh."
            )
        if master_before["jobReqIds"] != master_after["jobReqIds"]:
            raise RuntimeError("Master Sheet Job Requisition IDs changed during P-Roles refresh.")

        try:
            src_data = str(pt.PivotCache().SourceData)
        except Exception:
            src_data = source
        if "Posted Sheet" in str(src_data) or "Posted Sheet" in source_a1:
            raise RuntimeError("P-Roles source must remain Master Sheet, not Posted Sheet.")

        pivot_count_after = int(p_roles.PivotTables().Count)

        com_call(wb, "Save")

        return {
            "ok": True,
            "excelVersion": str(excel.Version),
            "pivotName": pivot_name,
            "pivotCount": pivot_count_after,
            "sourceR1C1": source,
            "sourceA1": source_a1,
            "sourceData": src_data,
            "rowFields": ROW_FIELDS,
            "columnField": COLUMN_FIELD,
            "valueField": VALUE_FIELD,
            "valueCaption": VALUE_CAPTION,
            "valueFieldsActive": data_fields,
            "filters": PAGE_FIELDS,
            "postedFilterItems": posted_items,
            "jmlOrderPivotItems": ordered,
            "jmlRenderedHeaders": jml_rendered,
            "jmlOrderOk": jml_ok,
            "masterSheetRows": last_row,
            "postedYesCount": master_after["postedValues"].count("Yes"),
            "postedDashCount": master_after["postedValues"].count("-"),
            "columnKModified": False,
            "masterSheetModified": False,
            "notes": notes,
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": str(exc),
            "traceback": traceback.format_exc(),
            "columnKModified": False,
            "masterSheetModified": False,
        }
    finally:
        try:
            if wb is not None:
                com_call(wb, "Close", False)
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


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Workbook path required."}))
        return
    print(json.dumps(refresh(sys.argv[1])))


if __name__ == "__main__":
    main()
