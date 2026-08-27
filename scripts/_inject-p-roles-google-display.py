"""Surgically insert P-Roles Google display into sheet XML without rewriting namespaces/pivot."""
from __future__ import annotations

import json
import sys
import zipfile
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

JMLS = [
    "8-Associate Manager",
    "9-Team Lead/Consultant",
    "10-Senior Analyst",
    "11-Analyst",
    "12-Associate",
]
HEADER_ROW = 17
DATA_START_ROW = 18


def q(tag: str) -> str:
    return f"{{{NS_MAIN}}}{tag}"


def zip_part_from_rel_target(target: str, names: set[str]) -> str:
    stripped = (target or "").replace("\\", "/").lstrip("/")
    candidates: list[str] = []
    for c in (stripped, f"xl/{stripped}"):
        c = c.lstrip("/")
        if c and c not in candidates:
            candidates.append(c)
        if c.startswith("xl/xl/"):
            fixed = c[len("xl/") :]
            if fixed not in candidates:
                candidates.append(fixed)
    for c in candidates:
        if c in names:
            return c
    raise RuntimeError(
        f"P-Roles sheet part not in workbook zip. rel Target={target!r}; tried={candidates}"
    )


def find_proles_sheet_part(z: zipfile.ZipFile) -> str:
    names = set(z.namelist())
    rel_root = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    rid_to_target = {rel.attrib.get("Id"): rel.attrib.get("Target") for rel in rel_root}
    wb_root = ET.fromstring(z.read("xl/workbook.xml"))
    sheets = wb_root.find(q("sheets"))
    if sheets is None:
        raise RuntimeError("workbook sheets missing")
    for sheet in list(sheets):
        if sheet.attrib.get("name") == "P-Roles":
            rid = sheet.attrib.get(f"{{{NS_REL}}}id")
            target = rid_to_target.get(rid)
            if not target:
                raise RuntimeError("P-Roles rId target missing")
            return zip_part_from_rel_target(target, names)
    raise RuntimeError("P-Roles sheet not found")


def inline(ref: str, text: str, style: str = "4") -> str:
    return (
        f'<c r="{ref}" s="{style}" t="inlineStr"><is><t xml:space="preserve">'
        f"{escape(text)}</t></is></c>"
    )


def boolean(ref: str, value: bool, style: str = "4") -> str:
    return f'<c r="{ref}" s="{style}" t="b"><v>{"1" if value else "0"}</v></c>'


def formula(ref: str, text: str, style: str = "4") -> str:
    return f'<c r="{ref}" s="{style}"><f>{escape(text)}</f></c>'


def empty(ref: str, style: str = "4") -> str:
    return f'<c r="{ref}" s="{style}"/>'


def row_xml(r: int, cells: list[str], spans: str = "1:26") -> str:
    return f'<row r="{r}" spans="{spans}" ht="14.25" customHeight="1">{"".join(cells)}</row>'


def count_formula(row: int, jml_col: str) -> str:
    skill = f"$A{row}"
    cat = f"$B{row}"
    header = f"{jml_col}${HEADER_ROW}"
    posted = "$B$14"
    market = "$B$15"
    ms = "'Master Sheet'"
    base = f"{ms}!$F:$F,{skill},{ms}!$E:$E,{cat},{ms}!$G:$G,{header}"

    def status_term(flag: str, status: str) -> str:
        k = f'{ms}!$K:$K,"{status}"'
        all_all = f"COUNTIFS({base},{k})"
        all_mkt = f"COUNTIFS({base},{k},{ms}!$I:$I,{market})"
        pst_all = f"COUNTIFS({base},{k},{ms}!$M:$M,{posted})"
        pst_mkt = f"COUNTIFS({base},{k},{ms}!$M:$M,{posted},{ms}!$I:$I,{market})"
        return (
            f"IF({flag},"
            f'IF({posted}="All",IF({market}="All",{all_all},{all_mkt}),'
            f'IF({market}="All",{pst_all},{pst_mkt})),0)'
        )

    return (
        status_term("$B$10", "Active")
        + "+"
        + status_term("$B$11", "New")
        + "+"
        + status_term("$B$12", "Reopen")
        + "+"
        + status_term("$B$13", "Closed")
    )


def build_rows(pairs: list[list[str]], markets: list[str]) -> str:
    market_values = ["All"] + markets

    def z_for(r: int) -> list[str]:
        idx = r - 9
        if 0 <= idx < len(market_values):
            return [inline(f"Z{r}", market_values[idx])]
        return []

    chunks: list[str] = []
    chunks.append(
        row_xml(
            9,
            [
                inline("A9", "Job Status (1 = include). Closed stays selectable."),
                empty("B9"),
                empty("C9"),
                empty("D9"),
                empty("E9"),
                empty("F9"),
                empty("G9"),
                empty("H9"),
            ]
            + z_for(9),
        )
    )
    chunks.append(row_xml(10, [inline("A10", "Active"), boolean("B10", True)] + [empty(f"{c}10") for c in "CDEFGH"] + z_for(10)))
    chunks.append(row_xml(11, [inline("A11", "New"), boolean("B11", True)] + [empty(f"{c}11") for c in "CDEFGH"] + z_for(11)))
    chunks.append(row_xml(12, [inline("A12", "Reopen"), boolean("B12", True)] + [empty(f"{c}12") for c in "CDEFGH"] + z_for(12)))
    chunks.append(row_xml(13, [inline("A13", "Closed"), boolean("B13", False)] + [empty(f"{c}13") for c in "CDEFGH"] + z_for(13)))
    chunks.append(row_xml(14, [inline("A14", "Posted"), inline("B14", "All")] + [empty(f"{c}14") for c in "CDEFGH"] + z_for(14)))
    chunks.append(row_xml(15, [inline("A15", "Market Map"), inline("B15", "All")] + [empty(f"{c}15") for c in "CDEFGH"] + z_for(15)))
    chunks.append(
        row_xml(
            16,
            [inline("A16", "Value = Count of Job Requisition ID from Master Sheet.")]
            + [empty(f"{c}16") for c in "BCDEFGH"]
            + z_for(16),
        )
    )
    chunks.append(
        row_xml(
            HEADER_ROW,
            [
                inline("A17", "Primary Skills"),
                inline("B17", "Skill Categorization"),
                inline("C17", JMLS[0]),
                inline("D17", JMLS[1]),
                inline("E17", JMLS[2]),
                inline("F17", JMLS[3]),
                inline("G17", JMLS[4]),
                inline("H17", "Grand Total"),
            ]
            + z_for(HEADER_ROW),
        )
    )
    jml_cols = ["C", "D", "E", "F", "G"]
    used_rows = {9, 10, 11, 12, 13, 14, 15, 16, HEADER_ROW}
    for i, pair in enumerate(pairs):
        r = DATA_START_ROW + i
        used_rows.add(r)
        cells = [inline(f"A{r}", pair[0]), inline(f"B{r}", pair[1])]
        for col in jml_cols:
            cells.append(formula(f"{col}{r}", count_formula(r, col)))
        cells.append(formula(f"H{r}", f"C{r}+D{r}+E{r}+F{r}+G{r}"))
        cells.extend(z_for(r))
        chunks.append(row_xml(r, cells))
    total_row = DATA_START_ROW + len(pairs)
    if pairs:
        used_rows.add(total_row)
        cells = [inline(f"A{total_row}", "Grand Total"), empty(f"B{total_row}")]
        for col in jml_cols + ["H"]:
            cells.append(formula(f"{col}{total_row}", f"SUM({col}{DATA_START_ROW}:{col}{total_row - 1})"))
        cells.extend(z_for(total_row))
        chunks.append(row_xml(total_row, cells))
    for r in range(9, 9 + len(market_values)):
        if r not in used_rows:
            chunks.append(row_xml(r, z_for(r)))
    return "".join(chunks)


def inject_sheet_xml(xml_bytes: bytes, pairs: list[list[str]], markets: list[str]) -> bytes:
    text = xml_bytes.decode("utf-8")
    last = DATA_START_ROW + max(len(pairs), 1) + 2
    text = text.replace(
        '<c r="A4" s="4"/>',
        inline("A4", "Google Sheets view starts at row 9. Excel users: use the PivotTable in rows 1-7."),
        1,
    )
    text = text.replace('dimension ref="A1:H1000"', f'dimension ref="A1:Z{max(last, 1000)}"', 1)
    start = text.find('<row r="9"')
    end = text.find("</sheetData>")
    if start < 0 or end < 0 or start >= end:
        raise RuntimeError("Could not locate row 9 / sheetData in P-Roles XML")
    # Require a real row 9, not row 90/91/...
    if not text[start:start + 20].startswith('<row r="9"'):
        raise RuntimeError("Row 9 marker was ambiguous")
    new_rows = build_rows(pairs, markets)
    market_end = 9 + len(markets)
    dvs = (
        '<dataValidations count="2">'
        '<dataValidation type="list" allowBlank="1" showDropDown="0" sqref="B14">'
        "<formula1>\"All,-,Yes\"</formula1></dataValidation>"
        '<dataValidation type="list" allowBlank="1" showDropDown="0" sqref="B15">'
        f"<formula1>$Z$9:$Z${market_end}</formula1></dataValidation>"
        "</dataValidations>"
    )
    text = text[:start] + new_rows + text[end:]
    if "<dataValidations" not in text:
        text = text.replace("</sheetData>", "</sheetData>" + dvs, 1)
    return text.encode("utf-8")


def inject(src: str, spec_path: str, dest: str) -> dict:
    spec = json.loads(open(spec_path, encoding="utf-8-sig").read())
    pairs = spec["pairs"]
    markets = spec["markets"]
    with zipfile.ZipFile(src, "r") as zin:
        part = find_proles_sheet_part(zin)
        original = zin.read(part)
        new_xml = inject_sheet_xml(original, pairs, markets)
        with zipfile.ZipFile(dest, "w") as zout:
            for info in zin.infolist():
                data = new_xml if info.filename == part else zin.read(info.filename)
                zout.writestr(info, data)
    return {
        "ok": True,
        "sheetPart": part,
        "pairCount": len(pairs),
        "marketCount": len(markets),
        "headerRow": HEADER_ROW,
        "dataStartRow": DATA_START_ROW,
        "totalRow": DATA_START_ROW + len(pairs),
        "jmlOrder": JMLS,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(inject(sys.argv[1], sys.argv[2], sys.argv[3])))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
