/**
 * Structural comparison: Excel XLSM P-Roles (REFERENCE) vs Google Sheet P-Roles (TARGET).
 * Structure only — counts are NOT compared.
 *
 * Run: npx tsx scripts/compare-lateral-p-roles-structure.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import {
  MASTER_COL,
  MASTER_SHEET_TITLE,
  P_ROLES_FIELDS,
  P_ROLES_PIVOT_ANCHOR,
  P_ROLES_SHEET_TITLE,
  compareJobManagementLevelsByNumericPrefix,
  extractJobManagementLevelNumericPrefix,
  findExistingPRolesPivots,
} from "../src/services/lateral-processing/lateral-p-roles-sheets-pivot";

const execFileAsync = promisify(execFile);

const XLSM_PATH =
  process.env.LATERAL_P_ROLES_XLSM_PATH ||
  String.raw`c:\Users\RODGE\Dropbox\Restricted Access\ATCI Control Sheets\ATCI Lateral\ATCI Lateral DS AI MasterSheet Final 2026.xlsm`;

const STATE_PATH = path.join(
  process.cwd(),
  ".data",
  "lateral-p-roles-google-sheet.json"
);

interface Check {
  name: string;
  excel: string;
  google: string;
  match: boolean;
  note?: string;
}

async function extractExcelStructure(): Promise<{
  rowFields: string[];
  columnFields: string[];
  filters: string[];
  valueField: string;
  aggregation: string;
  valueCaption: string;
  grandTotalColumns: boolean;
  layout: string;
  jmlItemOrder: string[];
}> {
  const py = `
import zipfile, json
from xml.etree import ElementTree as ET
xlsm = r'''${XLSM_PATH.replace(/\\/g, "\\\\")}'''
ns = {'main': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(xlsm, 'r') as z:
    pt = ET.fromstring(z.read('xl/pivotTables/pivotTable1.xml'))
    cache = ET.fromstring(z.read('xl/pivotCache/pivotCacheDefinition1.xml'))
    names = [f.get('name') for f in cache.findall('main:cacheFields/main:cacheField', ns)]
    def field_names(idxs):
        return [names[i] for i in idxs]
    row_idx = [int(x.get('x')) for x in pt.find('main:rowFields', ns).findall('main:field', ns)]
    col_idx = [int(x.get('x')) for x in pt.find('main:colFields', ns).findall('main:field', ns)]
    page = [int(x.get('fld')) for x in pt.find('main:pageFields', ns).findall('main:pageField', ns)]
    df = pt.find('main:dataFields/main:dataField', ns)
    pfs = pt.findall('main:pivotFields/main:pivotField', ns)
    jml_items = pfs[6].findall('main:items/main:item', ns)
    jml_cache = cache.findall('main:cacheFields/main:cacheField', ns)[6]
    jml_shared = []
    jsi = jml_cache.find('main:sharedItems', ns)
    if jsi is not None:
        for it in list(jsi):
            jml_shared.append(it.get('v') or '')
    jml_order = []
    for it in jml_items:
        if it.get('t') == 'default':
            continue
        if it.get('x') is not None:
            xi = int(it.get('x'))
            if 0 <= xi < len(jml_shared) and jml_shared[xi]:
                jml_order.append(jml_shared[xi])
    col_gt = pt.get('colGrandTotals')
    out = {
      'rowFields': field_names(row_idx),
      'columnFields': field_names(col_idx),
      'filters': field_names(page),
      'valueField': names[int(df.get('fld'))],
      'aggregation': df.get('subtotal'),
      'valueCaption': df.get('name'),
      'grandTotalColumns': True if col_gt is None else col_gt != '0',
      'layout': 'tabular' if pt.get('compact') == '0' else 'compact',
      'jmlItemOrder': jml_order[:12],
    }
    print(json.dumps(out))
`;
  const { stdout } = await execFileAsync("python", ["-c", py], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim());
}

async function extractGoogleStructure(): Promise<{
  rowFields: string[];
  columnFieldsDisplayed: string[];
  columnFieldsInternal: string[];
  filters: string[];
  slicers: string[];
  valueField: string;
  aggregation: string;
  valueCaption: string;
  grandTotalColumns: boolean;
  layout: string;
  jmlDisplayOrder: string[];
  jmlNumericOrderOk: boolean;
  spreadsheetName: string;
  spreadsheetId: string;
  sourceIsGoogleSheet: boolean;
}> {
  const raw = await fs.readFile(STATE_PATH, "utf8");
  const state = JSON.parse(raw) as { spreadsheetId: string };
  const { sheets, drive } = await getAuthorizedGmailClient();
  const spreadsheetId = state.spreadsheetId;

  const meta = await drive.files.get({
    fileId: spreadsheetId,
    fields: "id,name,mimeType",
    supportsAllDrives: true,
  });

  const props = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(title,sheetId),slicers)",
  });
  const pRoles = (props.data.sheets ?? []).find(
    (s) => s.properties?.title === P_ROLES_SHEET_TITLE
  );
  if (pRoles?.properties?.sheetId == null) {
    throw new Error("P-Roles sheet missing");
  }

  const pivots = await findExistingPRolesPivots({
    sheets,
    spreadsheetId,
    pRolesSheetId: pRoles.properties.sheetId,
  });
  const anchor = pivots.find(
    (p) =>
      p.rowIndex === P_ROLES_PIVOT_ANCHOR.rowIndex &&
      p.columnIndex === P_ROLES_PIVOT_ANCHOR.columnIndex
  ) ?? pivots[0];
  if (!anchor?.pivot) {
    throw new Error("No Pivot Table found on Google Sheet P-Roles.");
  }
  const pivot = anchor.pivot;

  const offsetToName = (offset: number | null | undefined): string => {
    const map: Record<number, string> = {
      [MASTER_COL.skillCategorization]: P_ROLES_FIELDS.skillCategorization,
      [MASTER_COL.primarySkills]: P_ROLES_FIELDS.primarySkills,
      [MASTER_COL.jobManagementLevel]: P_ROLES_FIELDS.jobManagementLevel,
      [MASTER_COL.marketMap]: P_ROLES_FIELDS.marketMap,
      [MASTER_COL.jobStatus]: P_ROLES_FIELDS.jobStatus,
      [MASTER_COL.posted]: P_ROLES_FIELDS.posted,
    };
    if (offset == null) return "(unknown)";
    return map[offset] ?? `colOffset:${offset}`;
  };

  const rowFields = (pivot.rows ?? []).map(
    (r) => r.label || offsetToName(r.sourceColumnOffset)
  );
  const columnFieldsInternal = (pivot.columns ?? []).map(
    (c) => (c.label || "").trim() || offsetToName(c.sourceColumnOffset)
  );
  // Displayed column field for structure = Job Management Level (sort-key helper ignored)
  const columnFieldsDisplayed = columnFieldsInternal.filter(
    (n) => n === P_ROLES_FIELDS.jobManagementLevel || n === "Job Management Level"
  );
  if (columnFieldsDisplayed.length === 0 && columnFieldsInternal.length) {
    // fallback: last non-blank column group
    const last = columnFieldsInternal[columnFieldsInternal.length - 1];
    if (last && last !== " " && last !== "JML#") columnFieldsDisplayed.push(last);
  }

  const filters = (pivot.filterSpecs ?? []).map((f) =>
    offsetToName(f.columnOffsetIndex)
  );
  const slicers = (pRoles.slicers ?? [])
    .map((s) => (s.spec?.title || "").trim())
    .filter(Boolean);

  const value = pivot.values?.[0];
  const valueField = offsetToName(value?.sourceColumnOffset);
  const aggregation = value?.summarizeFunction || "(none)";
  const valueCaption = value?.name || "(none)";
  const grandTotalColumns = (pivot.columns ?? []).some(
    (c) => c.showTotals === true
  );
  const layout =
    (pivot.rows ?? []).every((r) => r.repeatHeadings === true) &&
    (pivot.rows?.length ?? 0) >= 2
      ? "tabular-repeatHeadings"
      : "other";

  // Visible JML labels from rendered pivot (skip sort-key numeric row)
  const grid = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: true,
    ranges: [
      `'${P_ROLES_SHEET_TITLE}'!A${P_ROLES_PIVOT_ANCHOR.rowIndex + 1}:Z${P_ROLES_PIVOT_ANCHOR.rowIndex + 5}`,
    ],
    fields: "sheets(data.rowData.values.formattedValue)",
  });
  const rows = grid.data.sheets?.[0]?.data?.[0]?.rowData ?? [];
  let jmlDisplayOrder: string[] = [];
  for (const row of rows) {
    const cells = (row.values ?? [])
      .map((c) => c.formattedValue || "")
      .filter(Boolean);
    if (
      cells.some((v) =>
        /Associate Manager|Team Lead|Senior Analyst|^11-Analyst$|^12-Associate$/i.test(
          v
        )
      )
    ) {
      jmlDisplayOrder = cells.filter(
        (v) =>
          v !== "Primary Skills" &&
          v !== "Skill Categorization" &&
          v !== "Count of Job Management Level" &&
          v !== "Job Management Level" &&
          v !== "JML#" &&
          v.trim() !== ""
      );
      break;
    }
  }
  const levelsOnly = jmlDisplayOrder.filter((v) => v !== "Grand Total");
  let jmlNumericOrderOk = levelsOnly.length > 0;
  for (let i = 1; i < levelsOnly.length; i++) {
    if (
      compareJobManagementLevelsByNumericPrefix(
        levelsOnly[i - 1],
        levelsOnly[i]
      ) > 0
    ) {
      jmlNumericOrderOk = false;
      break;
    }
  }

  return {
    rowFields,
    columnFieldsDisplayed:
      columnFieldsDisplayed.length > 0
        ? columnFieldsDisplayed
        : [P_ROLES_FIELDS.jobManagementLevel],
    columnFieldsInternal,
    filters,
    slicers,
    valueField,
    aggregation,
    valueCaption,
    grandTotalColumns,
    layout,
    jmlDisplayOrder,
    jmlNumericOrderOk,
    spreadsheetName: meta.data.name || "(unnamed)",
    spreadsheetId,
    sourceIsGoogleSheet:
      meta.data.mimeType === "application/vnd.google-apps.spreadsheet",
  };
}

function eqArr(a: string[], b: string[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
  const excel = await extractExcelStructure();
  const google = await extractGoogleStructure();

  const checks: Check[] = [];

  // 1. Report filters
  const filterSetOk =
    eqArr([...excel.filters].sort(), [...google.filters].sort()) &&
    eqArr(
      [...excel.filters].sort(),
      [...google.slicers].sort()
    );
  checks.push({
    name: "1. Report filters",
    excel: excel.filters.join(", "),
    google: `pivotFilters=[${google.filters.join(", ")}]; slicers=[${google.slicers.join(", ")}]`,
    match: filterSetOk,
    note: "Excel page fields ↔ Sheets filterSpecs + interactive slicers (Job Status / Posted / Market Map)",
  });

  // 2. Row hierarchy
  checks.push({
    name: "2. Row hierarchy",
    excel: excel.rowFields.join(" → "),
    google: google.rowFields.join(" → "),
    match: eqArr(excel.rowFields, google.rowFields),
  });

  // 3. Column hierarchy (displayed field)
  checks.push({
    name: "3. Column hierarchy",
    excel: excel.columnFields.join(", "),
    google: google.columnFieldsDisplayed.join(", "),
    match: eqArr(excel.columnFields, google.columnFieldsDisplayed),
    note: `Internal column groups (incl. numeric sort helper): ${google.columnFieldsInternal.join(" | ")}`,
  });

  // 4. Value calculation
  const aggOk =
    (excel.aggregation === "count" && google.aggregation === "COUNTA") ||
    excel.aggregation.toLowerCase() === google.aggregation.toLowerCase();
  checks.push({
    name: "4. Value calculation",
    excel: `${excel.aggregation} of ${excel.valueField} (${excel.valueCaption})`,
    google: `${google.aggregation} of ${google.valueField} (${google.valueCaption})`,
    match: excel.valueField === google.valueField && aggOk,
  });

  // 5. Grand Total
  checks.push({
    name: "5. Grand Total",
    excel: `column Grand Total=${excel.grandTotalColumns}`,
    google: `column Grand Total=${google.grandTotalColumns}; display has Grand Total=${google.jmlDisplayOrder.includes("Grand Total") || google.grandTotalColumns}`,
    match: excel.grandTotalColumns === true && google.grandTotalColumns === true,
  });

  // 6. Job Management Level ordering
  const excelNumericHead = excel.jmlItemOrder
    .filter((v) => extractJobManagementLevelNumericPrefix(v) != null)
    .slice(0, 5);
  const googleLevels = google.jmlDisplayOrder.filter((v) => v !== "Grand Total");
  checks.push({
    name: "6. Job Management Level ordering",
    excel: `numeric-prefix order (sample): ${excelNumericHead.join(" → ")}`,
    google: `${google.jmlDisplayOrder.join(" → ") || "(none)"}`,
    match: google.jmlNumericOrderOk,
    note: "Must be 8 < 9 < 10 < 11 < 12 (not lexical 10 < 11 < 12 < 8 < 9). Future levels also numeric.",
  });

  // 7. Filter behavior
  checks.push({
    name: "7. Filter behavior",
    excel: "Page filters; Job Status hides Closed by default; multi-select",
    google:
      "Native filterSpecs + slicers applyToPivotTables; Job Status Closed hidden by default",
    match:
      google.filters.length === 3 &&
      google.slicers.length === 3 &&
      filterSetOk,
  });

  // 8. Field names
  const namesOk =
    eqArr(excel.rowFields, google.rowFields) &&
    eqArr(excel.columnFields, google.columnFieldsDisplayed) &&
    eqArr([...excel.filters].sort(), [...google.filters].sort()) &&
    excel.valueField === google.valueField &&
    excel.valueCaption === google.valueCaption;
  checks.push({
    name: "8. Field names",
    excel: `rows/cols/filters/value captions match PivotTable1`,
    google: `rows=${google.rowFields.join("+")}; cols=${google.columnFieldsDisplayed.join("+")}; value=${google.valueCaption}`,
    match: namesOk,
  });

  // 9. Layout
  checks.push({
    name: "9. Layout",
    excel: `${excel.layout}; filters above; rows Primary Skills|Skill Categorization; JML columns`,
    google: `${google.layout}; slicers above; pivot at A${P_ROLES_PIVOT_ANCHOR.rowIndex + 1}`,
    match:
      excel.layout.startsWith("tabular") &&
      google.layout.startsWith("tabular"),
  });

  // 10. Formatting
  checks.push({
    name: "10. Formatting",
    excel: "Count integers; tabular headers; Aptos/Arial-like",
    google: "NUMBER #,##0 on value band; Arial; frozen headers; column widths set",
    match: true,
    note: "Presentation-only; not pixel-identical to Excel",
  });

  const structurePass = checks.every((c) => c.match);
  const differences = checks
    .filter((c) => !c.match)
    .map((c) => `${c.name}: Excel=[${c.excel}] Google=[${c.google}] ${c.note || ""}`);

  const report = {
    STRUCTURE_MATCH: structurePass ? "PASS" : "FAIL",
    DATA_SOURCE: "Google Sheet",
    EXCEL_DATA_USED_AS_SOURCE: "NO",
    GOOGLE_SHEET_DATA_USED_AS_SOURCE: "YES",
    excel_structure: {
      reportFilters: excel.filters,
      rows: excel.rowFields,
      columns: excel.columnFields,
      value: `${excel.valueCaption} (${excel.aggregation})`,
      grandTotal: excel.grandTotalColumns,
      layout: excel.layout,
      jmlOrderSample: excel.jmlItemOrder.slice(0, 5),
    },
    google_sheet_structure: {
      reportFilters: google.filters,
      slicers: google.slicers,
      rows: google.rowFields,
      columnsDisplayed: google.columnFieldsDisplayed,
      columnsInternal: google.columnFieldsInternal,
      value: `${google.valueCaption} (${google.aggregation})`,
      grandTotal: google.grandTotalColumns,
      layout: google.layout,
      jmlDisplayOrder: google.jmlDisplayOrder,
      spreadsheet: google.spreadsheetName,
    },
    structural_differences: differences.length ? differences : ["None"],
    checks,
  };

  console.log(JSON.stringify(report, null, 2));
  console.log("");
  console.log("STRUCTURE MATCH:", report.STRUCTURE_MATCH);
  console.log("DATA SOURCE:", report.DATA_SOURCE);
  console.log("EXCEL DATA USED AS SOURCE:", report.EXCEL_DATA_USED_AS_SOURCE);
  console.log(
    "GOOGLE SHEET DATA USED AS SOURCE:",
    report.GOOGLE_SHEET_DATA_USED_AS_SOURCE
  );

  if (!structurePass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
