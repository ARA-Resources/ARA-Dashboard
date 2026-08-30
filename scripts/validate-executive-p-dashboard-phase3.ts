/**
 * Phase 3 validation: Executive P-Dashboard vs Master Sheet + Excel Active pivot.
 * Usage: npx tsx scripts/validate-executive-p-dashboard-phase3.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  assertExecutiveMasterHeaders,
  EXECUTIVE_MASTER_HEADER_ROW,
  EXECUTIVE_MASTER_SHEET_NAME,
  projectExecutiveMasterLiveColumns,
  type ExecutiveMasterSheetRow,
} from "../src/services/excel/executive-master-sheet";
import {
  buildExecutivePDashboardFromRows,
  extractExecutivePDashboardFilters,
  EXECUTIVE_P_DASHBOARD_LEVEL_COLUMNS,
  type ExecutivePDashboardFilterSelection,
} from "../src/services/executive-processing/executive-p-dashboard-engine";
import { parseWorksheet } from "../src/services/excel/parse-sheet";
import { resolveReadableExcelPath } from "../src/services/excel/readable-workbook";

async function resolveWorkbookPath(): Promise<string> {
  const fromEnv = (process.env.ARA_EXECUTIVE_EXCEL_PATH ?? "").trim();
  if (fromEnv) {
    await fs.access(fromEnv);
    return fromEnv;
  }
  const bundled = path.join(
    process.cwd(),
    "data",
    "excel",
    "executive-mastersheet.xlsm"
  );
  await fs.access(bundled);
  return bundled;
}

async function loadMasterRows(): Promise<ExecutiveMasterSheetRow[]> {
  const filePath = await resolveWorkbookPath();
  const readable = await resolveReadableExcelPath(filePath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(readable);
  const worksheet =
    workbook.worksheets.find(
      (item) =>
        item.name.trim().toLowerCase() ===
        EXECUTIVE_MASTER_SHEET_NAME.toLowerCase()
    ) ?? null;
  if (!worksheet) throw new Error("Master Sheet missing");
  const parsed = parseWorksheet(worksheet, {
    headerRow: EXECUTIVE_MASTER_HEADER_ROW,
  });
  assertExecutiveMasterHeaders(parsed.headers);
  return projectExecutiveMasterLiveColumns(
    parsed.headers,
    parsed.rows.map((row, index) => ({
      id: `validate-${index + 1}`,
      ...row,
    }))
  ).rows;
}

function totalsOf(
  filters: ExecutivePDashboardFilterSelection,
  rows: ExecutiveMasterSheetRow[]
) {
  return buildExecutivePDashboardFromRows(rows, filters).totals;
}

async function readExcelActivePivotTotals(): Promise<{
  "5-Associate Director": number;
  "6-Senior Manager": number;
  "7-Manager": number;
  groups: number;
}> {
  const filePath = await resolveWorkbookPath();
  const readable = await resolveReadableExcelPath(filePath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(readable);
  const sheet =
    workbook.worksheets.find(
      (item) => item.name.trim().toLowerCase() === "p - dashboard"
    ) ?? null;
  if (!sheet) throw new Error("P - Dashboard missing");

  // Header row is typically 7 (1-based) in the saved pivot layout.
  const headerRow = sheet.getRow(7);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] =
      cell.value === null || cell.value === undefined
        ? ""
        : String(cell.value);
  });

  const idx5 = headers.findIndex((h) => h === "5-Associate Director");
  const idx6 = headers.findIndex((h) => h === "6-Senior Manager");
  const idx7 = headers.findIndex((h) => h === "7-Manager");
  if (idx5 < 0 || idx6 < 0 || idx7 < 0) {
    throw new Error("Canonical Level columns missing on P - Dashboard");
  }

  let c5 = 0;
  let c6 = 0;
  let c7 = 0;
  let groups = 0;
  for (let r = 8; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const primary = row.getCell(1).value;
    if (primary === null || primary === undefined || primary === "") continue;
    groups += 1;
    const v5 = Number(row.getCell(idx5 + 1).value ?? 0);
    const v6 = Number(row.getCell(idx6 + 1).value ?? 0);
    const v7 = Number(row.getCell(idx7 + 1).value ?? 0);
    if (Number.isFinite(v5)) c5 += v5;
    if (Number.isFinite(v6)) c6 += v6;
    if (Number.isFinite(v7)) c7 += v7;
  }

  return {
    "5-Associate Director": c5,
    "6-Senior Manager": c6,
    "7-Manager": c7,
    groups,
  };
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function main() {
  const rows = await loadMasterRows();
  const empty = extractExecutivePDashboardFilters({});
  const active = extractExecutivePDashboardFilters({
    "Job Status": ["Active"],
  });
  const postedYes = extractExecutivePDashboardFilters({
    Posted: ["Yes"],
  });

  const priorities = [
    ...new Set(
      rows
        .map((r) => asText(r.Priority))
        .filter(Boolean)
    ),
  ];
  const members = [
    ...new Set(
      rows
        .map((r) => asText(r["Team Member 1"]))
        .filter(Boolean)
    ),
  ];
  const onePriority = priorities[0] ?? "Priority";
  const oneMember = members[0] ?? "";

  const priorityOnly = extractExecutivePDashboardFilters({
    Priority: [onePriority],
  });
  const memberOnly = extractExecutivePDashboardFilters({
    "Team Member 1": [oneMember],
  });
  const combined = extractExecutivePDashboardFilters({
    "Job Status": ["Active"],
    Posted: ["Yes"],
    Priority: [onePriority],
  });

  const cases = [
    { name: "No filters", filters: empty },
    { name: "Job Status = Active", filters: active },
    { name: "Posted = Yes", filters: postedYes },
    { name: `Priority = ${onePriority}`, filters: priorityOnly },
    { name: `Team Member 1 = ${oneMember}`, filters: memberOnly },
    {
      name: `Active + Posted Yes + Priority ${onePriority}`,
      filters: combined,
    },
  ] as const;

  const report: Array<Record<string, unknown>> = [];

  for (const test of cases) {
    const built = buildExecutivePDashboardFromRows(rows, test.filters);
    const sumRows = {
      "5-Associate Director": built.groups.reduce(
        (s, g) => s + g["5-Associate Director"],
        0
      ),
      "6-Senior Manager": built.groups.reduce(
        (s, g) => s + g["6-Senior Manager"],
        0
      ),
      "7-Manager": built.groups.reduce((s, g) => s + g["7-Manager"], 0),
    };
    const grandMatches =
      sumRows["5-Associate Director"] ===
        built.totals["5-Associate Director"] &&
      sumRows["6-Senior Manager"] === built.totals["6-Senior Manager"] &&
      sumRows["7-Manager"] === built.totals["7-Manager"];

    report.push({
      test: test.name,
      groups: built.groups.length,
      filteredDetailCount: built.totals.filteredDetailCount,
      totals: {
        "5-Associate Director": built.totals["5-Associate Director"],
        "6-Senior Manager": built.totals["6-Senior Manager"],
        "7-Manager": built.totals["7-Manager"],
        canonicalTotal: built.totals.canonicalTotal,
      },
      grandTotalEqualsSumOfGroups: grandMatches,
      dirtyExcludedFromCanonical:
        built.totals.canonicalTotal <= built.totals.filteredDetailCount,
    });
  }

  const excelActive = await readExcelActivePivotTotals();
  const appActive = totalsOf(active, rows);
  const activeMatch =
    excelActive["5-Associate Director"] ===
      appActive["5-Associate Director"] &&
    excelActive["6-Senior Manager"] === appActive["6-Senior Manager"] &&
    excelActive["7-Manager"] === appActive["7-Manager"];

  const noFilter = totalsOf(empty, rows);
  const expectedNoFilterCanonical = {
    "5-Associate Director": rows.filter(
      (r) => asText(r.Level) === "5-Associate Director"
    ).length,
    "6-Senior Manager": rows.filter(
      (r) => asText(r.Level) === "6-Senior Manager"
    ).length,
    "7-Manager": rows.filter((r) => asText(r.Level) === "7-Manager").length,
  };

  const summary = {
    ok:
      activeMatch &&
      noFilter["5-Associate Director"] ===
        expectedNoFilterCanonical["5-Associate Director"] &&
      noFilter["6-Senior Manager"] ===
        expectedNoFilterCanonical["6-Senior Manager"] &&
      noFilter["7-Manager"] === expectedNoFilterCanonical["7-Manager"] &&
      report.every((item) => item.grandTotalEqualsSumOfGroups === true),
    levelColumns: [...EXECUTIVE_P_DASHBOARD_LEVEL_COLUMNS],
    dirtyLevelPolicy:
      "Exact string match only; dirty Levels are not folded into canonical columns (Excel PivotTable behavior).",
    excelComparison: [
      {
        test: "Job Status = Active (Excel PivotTable1 saved state)",
        excel: {
          "5-Associate Director": excelActive["5-Associate Director"],
          "6-Senior Manager": excelActive["6-Senior Manager"],
          "7-Manager": excelActive["7-Manager"],
          groups: excelActive.groups,
        },
        application: {
          "5-Associate Director": appActive["5-Associate Director"],
          "6-Senior Manager": appActive["6-Senior Manager"],
          "7-Manager": appActive["7-Manager"],
          filteredDetailCount: appActive.filteredDetailCount,
        },
        match: activeMatch ? "YES" : "NO",
      },
      {
        test: "No filters (Master Sheet exact Level counts)",
        excel: "N/A (Excel pivot currently filtered to Active)",
        application: {
          "5-Associate Director": noFilter["5-Associate Director"],
          "6-Senior Manager": noFilter["6-Senior Manager"],
          "7-Manager": noFilter["7-Manager"],
        },
        expectedFromMaster: expectedNoFilterCanonical,
        match:
          noFilter["5-Associate Director"] ===
            expectedNoFilterCanonical["5-Associate Director"] &&
          noFilter["6-Senior Manager"] ===
            expectedNoFilterCanonical["6-Senior Manager"] &&
          noFilter["7-Manager"] === expectedNoFilterCanonical["7-Manager"]
            ? "YES"
            : "NO",
      },
    ],
    filterCases: report,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
  console.log("PHASE3_SMOKE_OK");
}

main().catch((error) => {
  console.error("PHASE3_SMOKE_FAIL", error);
  process.exit(1);
});
