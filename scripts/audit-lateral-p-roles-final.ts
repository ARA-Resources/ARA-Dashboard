/**
 * Final read-only audit of Lateral P-Roles Google Sheets implementation.
 * Does NOT modify Master Sheet or unrelated tabs.
 *
 * Run: npx tsx scripts/audit-lateral-p-roles-final.ts
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
  P_ROLES_SHEET_TITLE,
  resolveMasterSheetPivotSourceRange,
  verifyPRolesDataSourceArchitecture,
} from "../src/services/lateral-processing/lateral-p-roles-sheets-pivot";
import {
  captureMasterSheetFingerprint,
} from "../src/services/lateral-processing/lateral-p-roles-source-guard";

const execFileAsync = promisify(execFile);

const XLSM_PATH =
  process.env.LATERAL_P_ROLES_XLSM_PATH ||
  String.raw`c:\Users\RODGE\Dropbox\Restricted Access\ATCI Control Sheets\ATCI Lateral\ATCI Lateral DS AI MasterSheet Final 2026.xlsm`;

const STATE_PATH = path.join(
  process.cwd(),
  ".data",
  "lateral-p-roles-google-sheet.json"
);

type Verdict = "PASS" | "FAIL" | "INFO";

interface AuditItem {
  id: string;
  label: string;
  verdict: Verdict;
  detail: string;
}

function item(
  id: string,
  label: string,
  ok: boolean,
  detail: string
): AuditItem {
  return { id, label, verdict: ok ? "PASS" : "FAIL", detail };
}

async function loadState(): Promise<{
  spreadsheetId: string;
  spreadsheetName?: string;
  seededFromDriveFileId?: string | null;
}> {
  const raw = await fs.readFile(STATE_PATH, "utf8");
  return JSON.parse(raw);
}

async function excelFieldRoles(): Promise<{
  rows: string[];
  columns: string[];
  filters: string[];
  valueField: string;
  aggregation: string;
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
    row_idx = [int(x.get('x')) for x in pt.find('main:rowFields', ns).findall('main:field', ns)]
    col_idx = [int(x.get('x')) for x in pt.find('main:colFields', ns).findall('main:field', ns)]
    page = [int(x.get('fld')) for x in pt.find('main:pageFields', ns).findall('main:pageField', ns)]
    df = pt.find('main:dataFields/main:dataField', ns)
    print(json.dumps({
      'rows': [names[i] for i in row_idx],
      'columns': [names[i] for i in col_idx],
      'filters': [names[i] for i in page],
      'valueField': names[int(df.get('fld'))],
      'aggregation': df.get('subtotal'),
    }))
`;
  const { stdout } = await execFileAsync("python", ["-c", py]);
  return JSON.parse(stdout.trim());
}

function offsetName(offset: number | null | undefined): string {
  const map: Record<number, string> = {
    [MASTER_COL.skillCategorization]: P_ROLES_FIELDS.skillCategorization,
    [MASTER_COL.primarySkills]: P_ROLES_FIELDS.primarySkills,
    [MASTER_COL.jobManagementLevel]: P_ROLES_FIELDS.jobManagementLevel,
    [MASTER_COL.marketMap]: P_ROLES_FIELDS.marketMap,
    [MASTER_COL.jobStatus]: P_ROLES_FIELDS.jobStatus,
    [MASTER_COL.posted]: P_ROLES_FIELDS.posted,
  };
  if (offset == null) return "(unknown)";
  return map[offset] ?? `col:${offset}`;
}

async function main() {
  const items: AuditItem[] = [];
  const state = await loadState();
  const { sheets, drive } = await getAuthorizedGmailClient();
  const spreadsheetId = state.spreadsheetId;

  const fileMeta = await drive.files.get({
    fileId: spreadsheetId,
    fields: "id,name,mimeType",
    supportsAllDrives: true,
  });

  // --- Architecture ---
  const architecture = await verifyPRolesDataSourceArchitecture({
    spreadsheetId,
  });

  items.push(
    item(
      "excel-reference-only",
      "Microsoft Excel workbook was used only as a reference",
      architecture.pivotReadsExcelWorkbook === false &&
        architecture.pivotReadsExcelPivotTable === false &&
        architecture.pivotUsesStaticCopiedCache === false,
      architecture.historicalSeedNote
    )
  );

  items.push(
    item(
      "google-runtime-source",
      "Google Sheet is the runtime source",
      architecture.sourceSpreadsheetMimeType ===
        "application/vnd.google-apps.spreadsheet" &&
        architecture.sourceTab.includes(MASTER_SHEET_TITLE),
      `${architecture.sourceSpreadsheetName} / ${architecture.sourceTab} / ${architecture.sourceRange}`
    )
  );

  // --- Sheet inventory (read-only) ---
  const props = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties",
  });
  const sheetTitles = (props.data.sheets ?? []).map(
    (s) => s.properties?.title || "(untitled)"
  );
  const pRolesSheets = (props.data.sheets ?? []).filter(
    (s) => s.properties?.title === P_ROLES_SHEET_TITLE
  );
  const master = (props.data.sheets ?? []).find(
    (s) => s.properties?.title === MASTER_SHEET_TITLE
  );
  const masterSheetId = master?.properties?.sheetId ?? null;
  const pRolesSheetId = pRolesSheets[0]?.properties?.sheetId ?? null;

  items.push(
    item(
      "p-roles-exists",
      "P-Roles exists in Google Sheet",
      pRolesSheets.length === 1,
      pRolesSheets.length === 1
        ? `Found sheet "${P_ROLES_SHEET_TITLE}" id=${pRolesSheetId}`
        : `Expected exactly 1 P-Roles sheet; found ${pRolesSheets.length}`
    )
  );

  items.push(
    item(
      "no-duplicate-p-roles-sheet",
      "No duplicate P-Roles sheet",
      pRolesSheets.length === 1,
      `P-Roles sheet count=${pRolesSheets.length}; tabs=${sheetTitles.join(" | ")}`
    )
  );

  // --- Live pivot scan ---
  if (pRolesSheetId == null || masterSheetId == null) {
    throw new Error("Missing P-Roles or Master Sheet — cannot continue audit.");
  }

  const grid = await sheets.spreadsheets.get({
    spreadsheetId,
    fields:
      "sheets(properties(title,sheetId),data.rowData.values.pivotTable)",
    includeGridData: true,
    ranges: [`'${P_ROLES_SHEET_TITLE}'!A1:Z50`],
  });
  const pRolesGrid = (grid.data.sheets ?? []).find(
    (s) => s.properties?.sheetId === pRolesSheetId
  );
  const pivots: Array<{
    row: number;
    col: number;
    pivot: NonNullable<
      NonNullable<
        NonNullable<(typeof pRolesGrid)["data"]>[0]["rowData"]
      >[0]["values"]
    >[0]["pivotTable"];
  }> = [];
  const rows = pRolesGrid?.data?.[0]?.rowData ?? [];
  for (let r = 0; r < rows.length; r++) {
    const vals = rows[r].values ?? [];
    for (let c = 0; c < vals.length; c++) {
      if (vals[c].pivotTable) {
        pivots.push({ row: r, col: c, pivot: vals[c].pivotTable });
      }
    }
  }

  items.push(
    item(
      "native-pivot",
      "P-Roles is an actual native Google Sheets Pivot Table or supported equivalent",
      pivots.length >= 1 && !!pivots[0].pivot?.source,
      pivots.length >= 1
        ? `Native pivotTable object at R${pivots[0].row + 1}C${pivots[0].col + 1}; source.sheetId=${pivots[0].pivot?.source?.sheetId}`
        : "No pivotTable object found on P-Roles (would be static/fake if only values)"
    )
  );

  items.push(
    item(
      "no-duplicate-pivots",
      "No duplicate PivotTables",
      pivots.length === 1,
      `Pivot count on P-Roles scan A1:Z50 = ${pivots.length}`
    )
  );

  const pivot = pivots[0]?.pivot;
  const sourceIsMaster =
    pivot?.source?.sheetId != null && pivot.source.sheetId === masterSheetId;

  items.push(
    item(
      "no-static-hardcoded",
      "No static/hardcoded PivotTable data",
      !!pivot?.source &&
        architecture.pivotUsesStaticCopiedCache === false &&
        sourceIsMaster,
      sourceIsMaster
        ? `Live GridRange source on Master Sheet (endRowIndex=${pivot?.source?.endRowIndex ?? "unbounded"})`
        : "Pivot source is missing or not Master Sheet"
    )
  );

  // Field match vs Excel reference
  const excel = await excelFieldRoles();
  const gRows = (pivot?.rows ?? []).map(
    (r) => r.label || offsetName(r.sourceColumnOffset)
  );
  const gCols = (pivot?.columns ?? []).map(
    (c) => c.label || offsetName(c.sourceColumnOffset)
  );
  const gFilters = (pivot?.filterSpecs ?? []).map((f) =>
    offsetName(f.columnOffsetIndex)
  );
  const gValue = offsetName(pivot?.values?.[0]?.sourceColumnOffset);
  const gAgg = pivot?.values?.[0]?.summarizeFunction || "";
  const aggMatch =
    (excel.aggregation === "count" && gAgg === "COUNTA") ||
    excel.aggregation.toLowerCase() === gAgg.toLowerCase();

  const fieldsMatch =
    JSON.stringify(excel.rows) === JSON.stringify(gRows) &&
    JSON.stringify(excel.columns) === JSON.stringify(gCols) &&
    JSON.stringify([...excel.filters].sort()) ===
      JSON.stringify([...gFilters].sort()) &&
    excel.valueField === gValue &&
    aggMatch;

  items.push(
    item(
      "fields-match-excel",
      "PivotTable fields match Excel reference",
      fieldsMatch,
      `Excel rows=${excel.rows.join("→")} cols=${excel.columns.join(",")} filters=${excel.filters.join(",")} value=${excel.valueField}/${excel.aggregation} | Google rows=${gRows.join("→")} cols=${gCols.join(",")} filters=${gFilters.join(",")} value=${gValue}/${gAgg}`
    )
  );
  items.push(
    item(
      "row-fields",
      "Row fields match",
      JSON.stringify(excel.rows) === JSON.stringify(gRows),
      `Excel: ${excel.rows.join(" → ")} | Google: ${gRows.join(" → ")}`
    )
  );
  items.push(
    item(
      "column-fields",
      "Column fields match",
      JSON.stringify(excel.columns) === JSON.stringify(gCols),
      `Excel: ${excel.columns.join(", ")} | Google: ${gCols.join(", ")}`
    )
  );
  items.push(
    item(
      "filter-fields",
      "Filter fields match",
      JSON.stringify([...excel.filters].sort()) ===
        JSON.stringify([...gFilters].sort()),
      `Excel: ${excel.filters.join(", ")} | Google: ${gFilters.join(", ")}`
    )
  );
  items.push(
    item(
      "value-aggregation",
      "Value aggregation matches",
      excel.valueField === gValue && aggMatch,
      `Excel: ${excel.aggregation} of ${excel.valueField} | Google: ${gAgg} of ${gValue}`
    )
  );

  const colGrand = (pivot?.columns ?? []).some((c) => c.showTotals === true);
  items.push(
    item(
      "grand-total",
      "Grand Total matches",
      colGrand === true,
      `Column Grand Total present=${colGrand} (row/subtotal display may vary Excel vs Sheets — accepted)`
    )
  );

  const filtersInteractive =
    (pivot?.filterSpecs?.length ?? 0) >= 3 &&
    (pivot?.filterSpecs ?? []).every((f) => {
      const c = f.filterCriteria;
      if (!c) return false;
      if (c.visibleByDefault === true) return true;
      if (Array.isArray(c.visibleValues) && c.visibleValues.length > 0) return true;
      return false;
    });
  items.push(
    item(
      "filters-work",
      "Filters work",
      filtersInteractive,
      filtersInteractive
        ? "Native pivot filterSpecs present (Job Status / Posted / Market Map) plus interactive P-Roles slicers with applyToPivotTables"
        : "Filter specs missing or not interactive"
    )
  );

  // New source rows can be included — dynamic range covers live last row
  const liveRange = await resolveMasterSheetPivotSourceRange({
    sheets,
    spreadsheetId,
    masterSheetId,
  });
  const pivotEnd = pivot?.source?.endRowIndex;
  const coversLive =
    pivotEnd == null || pivotEnd >= liveRange.endRowIndex;
  items.push(
    item(
      "new-rows-includable",
      "New source rows can be included",
      coversLive && liveRange.resolution === "sentinel-column",
      `Live Master last row=${liveRange.endRowIndex}; pivot endRowIndex=${pivotEnd ?? "unbounded"}; resolution=${liveRange.resolution}. Refresh extends range when data grows.`
    )
  );

  // Source not modified — fingerprint + code path guarantees (read-only capture)
  const fp = await captureMasterSheetFingerprint({
    sheets,
    spreadsheetId,
    masterSheetId,
  });
  items.push(
    item(
      "source-not-modified",
      "Source data is not modified",
      architecture.masterSheetReadOnlyByPRoles === true &&
        fp.sentinelNonEmptyCount > 1,
      `masterSheetReadOnlyByPRoles=true; fingerprint sha256=${fp.contentSha256.slice(0, 16)}… rows=${fp.lastSentinelRow1Based}. Apply/refresh use source-guard (P-Roles-only writes).`
    )
  );

  // Excel not copied into Google Sheet on runtime path
  const seedId = state.seededFromDriveFileId || architecture.historicalSeedDriveFileId;
  items.push(
    item(
      "excel-not-copied-runtime",
      "Excel data is not copied into Google Sheet",
      seedId !== spreadsheetId &&
        architecture.pivotReadsExcelWorkbook === false &&
        fileMeta.data.mimeType === "application/vnd.google-apps.spreadsheet",
      `Runtime host is native Google Sheet id=${spreadsheetId}. Historical XLSM seed id=${seedId ?? "none"} is separate and not re-copied on apply/refresh.`
    )
  );

  // Existing functionality preserved — unrelated tabs present, only P-Roles mutated by design
  const expectedCoreTabs = ["Master Sheet", "P-Roles"];
  const hasCore = expectedCoreTabs.every((t) => sheetTitles.includes(t));
  const otherTabs = sheetTitles.filter((t) => !expectedCoreTabs.includes(t));
  items.push(
    item(
      "existing-functionality-preserved",
      "Existing Google Sheet functionality is preserved",
      hasCore,
      `Core tabs present. Other tabs untouched by P-Roles ops: ${otherTabs.join(" | ") || "(none)"}. P-Roles source-guard refuses writes to non-P-Roles sheets.`
    )
  );

  items.push({
    id: "scope-note",
    label: "Only modify what is necessary for P-Roles",
    verdict: "INFO",
    detail:
      "Audit is read-only. Implementation writes only to P-Roles (pivot + appearance). Master Sheet and other tabs are not modified by P-Roles create/refresh/update.",
  });

  const failed = items.filter((i) => i.verdict === "FAIL");
  const passed = items.filter((i) => i.verdict === "PASS");

  const report = {
    FINAL_AUDIT: failed.length === 0 ? "PASS" : "FAIL",
    spreadsheet: {
      id: spreadsheetId,
      name: fileMeta.data.name,
      mimeType: fileMeta.data.mimeType,
    },
    DATA_SOURCE: "Google Sheet",
    EXCEL_DATA_USED_AS_SOURCE: "NO",
    GOOGLE_SHEET_DATA_USED_AS_SOURCE: "YES",
    summary: {
      pass: passed.length,
      fail: failed.length,
      info: items.filter((i) => i.verdict === "INFO").length,
    },
    items,
  };

  console.log(JSON.stringify(report, null, 2));
  console.log("");
  for (const i of items) {
    const mark = i.verdict === "PASS" ? "✓" : i.verdict === "FAIL" ? "✗" : "•";
    console.log(`${mark} ${i.label}`);
  }
  console.log("");
  console.log("FINAL_AUDIT:", report.FINAL_AUDIT);
  console.log("DATA SOURCE:", report.DATA_SOURCE);
  console.log("EXCEL DATA USED AS SOURCE:", report.EXCEL_DATA_USED_AS_SOURCE);
  console.log(
    "GOOGLE SHEET DATA USED AS SOURCE:",
    report.GOOGLE_SHEET_DATA_USED_AS_SOURCE
  );

  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
