"""
STEP 9.2 — Surgical JML column-item Position only.

Does NOT: RefreshTable, change source, change filters, recreate pivot,
modify Master/Posted/New data.

Usage:
  python _step92-jml-order-only.py inspect <xlsm>
  python _step92-jml-order-only.py apply <xlsm>
"""
from __future__ import annotations

import json
import sys
import traceback

XL_MANUAL = -4135
XL_ROW_FIELD = 1
XL_COLUMN_FIELD = 2
XL_PAGE_FIELD = 3
MSO_AUTOMATION_SECURITY_FORCE_DISABLE = 3

COLUMN_FIELD = "Job Management Level"
VALUE_CAPTION = "Count of Job Requisition ID"
VALUE_FIELD = "Job Requisition ID"
ROW_FIELDS = ["Primary Skills", "Skill Categorization"]
PAGE_FIELDS = ["Job Status", "Posted", "Market Map"]
JML_CANONICAL = [
    "8-Associate Manager",
    "9-Team Lead/Consultant",
    "10-Senior Analyst",
    "11-Analyst",
    "12-Associate",
]


def com_call(obj, name: str, *args):
    fn = getattr(obj, name)
    if callable(fn):
        return fn(*args)
    return fn


def item_names(field) -> list[str]:
    names: list[str] = []
    for item in field.PivotItems():
        name = str(item.Name)
        if name.startswith("("):
            continue
        names.append(name)
    return names


def visible_items(field) -> list[str]:
    out: list[str] = []
    for item in field.PivotItems():
        name = str(item.Name)
        if name.startswith("("):
            continue
        try:
            if item.Visible:
                out.append(name)
        except Exception:
            pass
    return out


def jml_by_position(field) -> list[str]:
    rows: list[tuple[int, str]] = []
    for item in field.PivotItems():
        name = str(item.Name)
        if name.startswith("("):
            continue
        try:
            pos = int(item.Position)
        except Exception:
            pos = 10_000
        rows.append((pos, name))
    rows.sort()
    return [name for _, name in rows]


def collect_data_field_names(pt) -> list[str]:
    return [str(df.Name) for df in pt.DataFields]


def snapshot(pt, p_roles) -> dict:
    row_fields: list[str] = []
    col_fields: list[str] = []
    page_fields: list[str] = []
    for f in pt.PivotFields():
        try:
            orientation = int(f.Orientation)
        except Exception:
            continue
        name = str(f.Name)
        if orientation == XL_ROW_FIELD:
            row_fields.append(name)
        elif orientation == XL_COLUMN_FIELD:
            col_fields.append(name)
        elif orientation == XL_PAGE_FIELD:
            page_fields.append(name)

    try:
        source = str(pt.PivotCache().SourceData)
    except Exception:
        source = ""

    jml_field = pt.PivotFields(COLUMN_FIELD)
    jml_order = jml_by_position(jml_field)

    return {
        "pivotName": str(pt.Name),
        "pivotCount": int(p_roles.PivotTables().Count),
        "rowFields": row_fields,
        "columnFields": col_fields,
        "pageFields": page_fields,
        "valueFields": collect_data_field_names(pt),
        "sourceData": source,
        "jmlOrder": jml_order,
        "jmlOrderOk": jml_order[:5] == JML_CANONICAL
        or jml_order == JML_CANONICAL,
        "postedItems": item_names(pt.PivotFields("Posted")),
        "postedVisible": visible_items(pt.PivotFields("Posted")),
        "jobStatusVisible": visible_items(pt.PivotFields("Job Status")),
        "marketMapVisible": visible_items(pt.PivotFields("Market Map")),
    }


def open_excel(path: str, read_only: bool):
    import pythoncom
    import win32com.client

    pythoncom.CoInitialize()
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
        ReadOnly=read_only,
        IgnoreReadOnlyRecommended=True,
    )
    return pythoncom, excel, wb


def close_excel(pythoncom, excel, wb, save: bool) -> None:
    try:
        if wb is not None:
            com_call(wb, "Close", save)
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


def inspect(path: str) -> dict:
    pythoncom = excel = wb = None
    try:
        pythoncom, excel, wb = open_excel(path, read_only=True)
        names = [ws.Name for ws in wb.Worksheets]
        if "P-Roles" not in names:
            raise RuntimeError(f"P-Roles missing. Found: {names}")
        p_roles = wb.Worksheets("P-Roles")
        count = int(p_roles.PivotTables().Count)
        if count != 1:
            raise RuntimeError(f"P-Roles must have exactly one PivotTable (found {count}).")
        pt = p_roles.PivotTables(1)
        snap = snapshot(pt, p_roles)
        snap["ok"] = True
        snap["sheets"] = names
        return snap
    except Exception as exc:
        return {"ok": False, "error": str(exc), "traceback": traceback.format_exc()}
    finally:
        close_excel(pythoncom, excel, wb, save=False)


def apply(path: str) -> dict:
    pythoncom = excel = wb = None
    notes: list[str] = []
    try:
        pythoncom, excel, wb = open_excel(path, read_only=False)
        p_roles = wb.Worksheets("P-Roles")
        if int(p_roles.PivotTables().Count) != 1:
            raise RuntimeError(
                f"P-Roles must have exactly one PivotTable (found {p_roles.PivotTables().Count})."
            )
        pt = p_roles.PivotTables(1)
        if str(pt.Name) != "P-Roles":
            raise RuntimeError(f'COM name is "{pt.Name}", expected "P-Roles".')

        before = snapshot(pt, p_roles)

        field = pt.PivotFields(COLUMN_FIELD)
        try:
            field.AutoSort(XL_MANUAL, COLUMN_FIELD)
        except Exception as exc:
            notes.append(f"AutoSort manual skipped: {exc}")

        labels = set(item_names(field))
        missing = [name for name in JML_CANONICAL if name not in labels]
        if missing:
            raise RuntimeError(f"Missing JML items: {missing}. Labels={sorted(labels)}")

        for _pass in range(3):
            for index, name in enumerate(JML_CANONICAL, start=1):
                item = field.PivotItems(name)
                if int(item.Position) != index:
                    item.Position = index

        after = snapshot(pt, p_roles)
        if after["jmlOrder"][:5] != JML_CANONICAL:
            raise RuntimeError(
                f"JML order did not stick before save: {after['jmlOrder']}"
            )
        if after["pivotCount"] != 1 or after["pivotName"] != "P-Roles":
            raise RuntimeError("Pivot identity changed during Position assign.")
        if after["sourceData"] != before["sourceData"]:
            raise RuntimeError("Pivot source changed; refusing save.")
        if after["postedVisible"] != before["postedVisible"]:
            raise RuntimeError("Posted filter selections changed; refusing save.")
        if after["jobStatusVisible"] != before["jobStatusVisible"]:
            raise RuntimeError("Job Status filter selections changed; refusing save.")
        if after["marketMapVisible"] != before["marketMapVisible"]:
            raise RuntimeError("Market Map filter selections changed; refusing save.")
        if after["rowFields"] != before["rowFields"] or after["columnFields"] != before["columnFields"]:
            raise RuntimeError("Row/column fields changed; refusing save.")
        if after["valueFields"] != before["valueFields"]:
            raise RuntimeError("Value fields changed; refusing save.")

        com_call(wb, "Save")
        return {
            "ok": True,
            "saved": True,
            "notes": notes,
            "before": before,
            "after": after,
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": str(exc),
            "traceback": traceback.format_exc(),
            "notes": notes,
        }
    finally:
        close_excel(pythoncom, excel, wb, save=False)


def main() -> None:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "Usage: inspect|apply <xlsm>"}))
        return
    action = sys.argv[1].strip().lower()
    path = sys.argv[2]
    if action == "inspect":
        print(json.dumps(inspect(path)))
        return
    if action == "apply":
        print(json.dumps(apply(path)))
        return
    print(json.dumps({"ok": False, "error": f"Unknown action {action}"}))


if __name__ == "__main__":
    main()
