"""
Rebuild P-Roles PivotTable on a Lateral Master XLSM to match the Excel
reference layout (tabular, page filters, COUNTA of JML).

Does NOT modify Master Sheet values.
"""
from __future__ import annotations

import json
import re
import sys
import traceback

XL_DATABASE = 1
XL_ROW_FIELD = 1
XL_COLUMN_FIELD = 2
XL_PAGE_FIELD = 3
XL_COUNT = -4112
XL_TABULAR_ROW = 1
XL_LAYOUT_FORM_TABULAR = 0  # XlLayoutFormType.xlTabular (not RowAxisLayout)
XL_REPEAT_LABELS = 1
XL_UP = -4162
MSO_AUTOMATION_SECURITY_FORCE_DISABLE = 3

ROW_FIELDS = ["Primary Skills", "Skill Categorization"]
COLUMN_FIELD = "Job Management Level"
VALUE_FIELD = "Job Management Level"
VALUE_CAPTION = "Count of Job Management Level"
PAGE_FIELDS = ["Job Status", "Posted", "Market Map"]


def jml_sort_key(label: str) -> tuple[int, str]:
    m = re.match(r"^(\d+)", str(label).strip())
    return (int(m.group(1)) if m else 10_000, str(label).lower())


def com_call(obj, name: str, *args):
    """win32com may already invoke no-arg methods on attribute access."""
    fn = getattr(obj, name)
    if callable(fn):
        return fn(*args)
    return fn


def rebuild(path: str) -> dict:
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
            raise RuntimeError("Master Sheet missing — cannot build P-Roles source.")

        p_roles = wb.Worksheets("P-Roles")
        master = wb.Worksheets("Master Sheet")

        # Capture Master Sheet identity so we can prove we did not rewrite it.
        master_used = master.UsedRange
        master_rows_before = int(master_used.Rows.Count)
        master_a1_before = str(master.Range("A1").Text)

        # Remove existing pivots / slicers on P-Roles only.
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
        p_roles.Tab.Color = 15773696  # Excel-like blue tab

        last_row = master.Cells(master.Rows.Count, 2).End(XL_UP).Row
        if last_row < 2:
            raise RuntimeError("Master Sheet has no data rows for P-Roles source.")
        last_col = 13  # A:M — same fields Excel PivotCache uses
        source = f"'Master Sheet'!R1C1:R{last_row}C{last_col}"

        cache = wb.PivotCaches().Create(SourceType=XL_DATABASE, SourceData=source)
        pt = cache.CreatePivotTable(
            TableDestination=p_roles.Range("A5"),
            TableName="PivotTable1",
        )

        missing = []
        for name in [*ROW_FIELDS, COLUMN_FIELD, *PAGE_FIELDS]:
            try:
                pt.PivotFields(name)
            except Exception:
                missing.append(name)
        if missing:
            raise RuntimeError(
                "P-Roles fields missing on Master Sheet: " + ", ".join(missing)
            )

        # Page fields first (add last → first so Excel displays Job Status, Posted, Market Map).
        for name in reversed(PAGE_FIELDS):
            field = pt.PivotFields(name)
            field.Orientation = XL_PAGE_FIELD

        for name in ROW_FIELDS:
            field = pt.PivotFields(name)
            field.Orientation = XL_ROW_FIELD

        # Values must be added before Columns. AddDataField on JML would otherwise
        # steal it off the column axis (leaving a single stacked count column).
        pt.AddDataField(pt.PivotFields(VALUE_FIELD), VALUE_CAPTION, XL_COUNT)
        pt.PivotFields(COLUMN_FIELD).Orientation = XL_COLUMN_FIELD

        pt.RowAxisLayout(XL_TABULAR_ROW)
        try:
            pt.RepeatAllLabels(XL_REPEAT_LABELS)
        except Exception as exc:
            notes.append(f"RepeatAllLabels skipped: {exc}")

        # Excel screenshot: tabular rows, no "* Total" subtotal rows.
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
        pt.DisplayErrorString = False
        try:
            pt.TableStyle2 = "PivotStyleMedium2"
            pt.ShowTableStyleRowStripes = True
            pt.ShowTableStyleColumnStripes = False
        except Exception as exc:
            notes.append(f"style skipped: {exc}")

        # Excel default: Closed hidden; Posted / Market Map = All.
        js = pt.PivotFields("Job Status")
        try:
            js.EnableMultiplePageItems = True
        except Exception:
            pass
        hidden_closed = False
        visible_status: list[str] = []
        for item in js.PivotItems():
            name = str(item.Name)
            if name.startswith("(") and name.lower().endswith(")"):
                continue
            want_visible = name.strip().lower() != "closed"
            try:
                item.Visible = want_visible
                if want_visible:
                    visible_status.append(name)
                else:
                    hidden_closed = True
            except Exception as exc:
                notes.append(f"Job Status '{name}' visibility skipped: {exc}")

        # Numeric JML column order: 8 < 9 < 10 < 11 < 12 (from source labels only).
        XL_MANUAL = -4135
        jml = pt.PivotFields(COLUMN_FIELD)
        try:
            jml.AutoSort(XL_MANUAL, COLUMN_FIELD)
        except Exception as exc:
            notes.append(f"JML AutoSort manual skipped: {exc}")
        labels: list[str] = []
        for item in jml.PivotItems():
            name = str(item.Name)
            if name.startswith("("):
                continue
            labels.append(name)
        ordered = sorted(set(labels), key=jml_sort_key)
        for index, name in enumerate(ordered, start=1):
            try:
                jml.PivotItems(name).Position = index
            except Exception as exc:
                notes.append(f"JML position '{name}' skipped: {exc}")

        com_call(pt, "RefreshTable")

        # Visible slicers for Job Status / Posted / Market Map (page fields stay in A1:B3).
        try:
            start_left = float(p_roles.Range("I1").Left)
            start_top = float(p_roles.Range("A1").Top)
            width = 168.0
            height = 78.0
            gap = 12.0
            for index, field_name in enumerate(PAGE_FIELDS):
                try:
                    try:
                        cache_obj = wb.SlicerCaches.Add2(pt, field_name)
                    except Exception:
                        cache_obj = wb.SlicerCaches.Add(pt, field_name)
                    slicer = cache_obj.Slicers.Add(
                        p_roles,
                        Top=start_top,
                        Left=start_left + index * (width + gap),
                        Width=width,
                        Height=height,
                    )
                    slicer.Caption = field_name
                    try:
                        slicer.RowHeight = 16
                        slicer.NumberOfColumns = 1
                    except Exception:
                        pass
                    notes.append(f"slicer added: {field_name}")
                except Exception as exc:
                    notes.append(f"slicer '{field_name}' skipped: {exc}")
        except Exception as exc:
            notes.append(f"slicer band skipped: {exc}")

        loc = str(pt.TableRange2.Address)
        sample = []
        for r in range(1, 9):
            sample.append(
                [str(p_roles.Cells(r, c).Text or "") for c in range(1, 8)]
            )
        last_data_row = pt.TableRange2.Row + pt.TableRange2.Rows.Count - 1
        gt_value = str(p_roles.Cells(last_data_row, pt.TableRange2.Columns.Count).Text or "")
        grand_total_label = str(p_roles.Cells(last_data_row, 1).Text or "")

        master_rows_after = int(master.UsedRange.Rows.Count)
        master_a1_after = str(master.Range("A1").Text)
        if master_rows_before != master_rows_after or master_a1_before != master_a1_after:
            raise RuntimeError("Master Sheet changed during P-Roles rebuild — aborting save.")

        com_call(wb, "Save")
        return {
            "ok": True,
            "excelVersion": str(excel.Version),
            "source": source,
            "pivotLocation": loc,
            "rowFields": ROW_FIELDS,
            "columnFields": [COLUMN_FIELD],
            "filters": PAGE_FIELDS,
            "valueCaption": VALUE_CAPTION,
            "hiddenClosed": hidden_closed,
            "visibleJobStatus": visible_status,
            "jmlOrder": ordered,
            "sampleA1G8": sample,
            "grandTotalCell": gt_value,
            "grandTotalLabel": grand_total_label,
            "masterSheetUnchanged": True,
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
    print(json.dumps(rebuild(sys.argv[1]), indent=2))
