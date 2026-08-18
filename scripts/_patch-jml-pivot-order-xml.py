"""
Hard-patch PivotTable1 OOXML so Job Management Level cannot stay alphabetical.

Excel sometimes rewrites sortType=ascending on save/refresh.
This removes ascending sort and forces item order 8→9→10→11→12.
"""
from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
ET.register_namespace(
    "", "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
)

JML_CANONICAL = [
    "8-Associate Manager",
    "9-Team Lead/Consultant",
    "10-Senior Analyst",
    "11-Analyst",
    "12-Associate",
]


def jml_key(label: str) -> tuple[int, str]:
    m = re.match(r"^(\d+)", str(label).strip())
    return (int(m.group(1)) if m else 10_000, str(label).lower())


def patch_xlsm(path: str) -> dict:
    src = Path(path)
    tmp = src.with_suffix(".patched.xlsm")

    with zipfile.ZipFile(src, "r") as zin:
        names = zin.namelist()
        pt_bytes = zin.read("xl/pivotTables/pivotTable1.xml")
        cache_bytes = zin.read("xl/pivotCache/pivotCacheDefinition1.xml")

        pt = ET.fromstring(pt_bytes)
        cache = ET.fromstring(cache_bytes)
        field_names = [
            f.get("name")
            for f in cache.findall("main:cacheFields/main:cacheField", NS)
        ]
        jml_i = field_names.index("Job Management Level")
        pfs = pt.findall("main:pivotFields/main:pivotField", NS)
        cfs = cache.findall("main:cacheFields/main:cacheField", NS)
        pf = pfs[jml_i]

        before_sort = pf.get("sortType")
        if "sortType" in pf.attrib:
            del pf.attrib["sortType"]

        shared: list[str] = []
        jsi = cfs[jml_i].find("main:sharedItems", NS)
        if jsi is not None:
            for it in list(jsi):
                shared.append(it.get("v") or "")

        items_el = pf.find("main:items", NS)
        if items_el is None:
            raise RuntimeError("JML pivot field has no <items>")

        # Collect existing item nodes keyed by label
        by_label: dict[str, ET.Element] = {}
        default_nodes: list[ET.Element] = []
        other_nodes: list[ET.Element] = []
        for it in list(items_el):
            if it.get("t") == "default":
                default_nodes.append(it)
                continue
            label = None
            if it.get("x") is not None:
                xi = int(it.get("x"))
                if 0 <= xi < len(shared):
                    label = shared[xi]
            if label:
                by_label[label] = it
            else:
                other_nodes.append(it)

        ordered_labels: list[str] = []
        for canon in JML_CANONICAL:
            if canon in by_label and canon not in ordered_labels:
                ordered_labels.append(canon)
        for label in sorted(by_label.keys(), key=jml_key):
            if label not in ordered_labels:
                ordered_labels.append(label)

        # Rebuild items in numeric order; keep all Visible (no h=1 on JML)
        for child in list(items_el):
            items_el.remove(child)
        for label in ordered_labels:
            node = by_label[label]
            if "h" in node.attrib:
                del node.attrib["h"]
            items_el.append(node)
        for node in other_nodes:
            items_el.append(node)
        for node in default_nodes:
            items_el.append(node)
        items_el.set("count", str(len(list(items_el))))

        # Also clear ascending on cache field if present
        cf = cfs[jml_i]
        if "sortType" in cf.attrib:
            del cf.attrib["sortType"]

        new_pt = ET.tostring(pt, encoding="utf-8", xml_declaration=True)
        new_cache = ET.tostring(cache, encoding="utf-8", xml_declaration=True)

        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zout:
            for name in names:
                if name == "xl/pivotTables/pivotTable1.xml":
                    zout.writestr(name, new_pt)
                elif name == "xl/pivotCache/pivotCacheDefinition1.xml":
                    zout.writestr(name, new_cache)
                else:
                    zout.writestr(name, zin.read(name))

    tmp.replace(src)
    return {
        "ok": True,
        "beforeSortType": before_sort,
        "afterSortType": None,
        "orderedLabels": ordered_labels,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "path required"}))
        sys.exit(1)
    print(json.dumps(patch_xlsm(sys.argv[1]), indent=2))
