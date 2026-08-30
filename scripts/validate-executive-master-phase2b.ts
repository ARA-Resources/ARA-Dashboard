/**
 * Phase 2B smoke: filter/pagination/export helpers against local Executive XLSM.
 * Avoids importing server-only reader modules.
 *
 * Usage: npx tsx scripts/validate-executive-master-phase2b.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  applyExecutiveMasterFilters,
  assertExecutiveMasterHeaders,
  discoverExecutiveMasterFilters,
  EXECUTIVE_MASTER_HEADER_ROW,
  EXECUTIVE_MASTER_LIVE_COLUMNS,
  EXECUTIVE_MASTER_SHEET_NAME,
  paginateExecutiveRows,
  projectExecutiveMasterLiveColumns,
} from "../src/services/excel/executive-master-sheet";
import { buildMasterSheetXlsxBuffer } from "../src/services/excel/build-master-sheet-xlsx";
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

async function main() {
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
  const projected = projectExecutiveMasterLiveColumns(
    parsed.headers,
    parsed.rows.map((row, index) => ({
      id: `validate-${index + 1}`,
      ...row,
    }))
  );

  console.log("sourceFile:", path.basename(filePath));
  console.log("headers:", projected.headers.length);
  console.log("totalRows:", projected.rows.length);

  const orderOk = projected.headers.every(
    (h, i) => h === EXECUTIVE_MASTER_LIVE_COLUMNS[i]
  );
  console.log("columnOrderExact:", orderOk);
  console.log(
    "excludesHistoricalZ:",
    !projected.headers.some((h) => /job\s*status\s*-/i.test(h))
  );

  const fields = discoverExecutiveMasterFilters(
    projected.headers,
    projected.rows
  );
  console.log("filterFields:", fields.length);
  console.log(
    "filterCoverage:",
    EXECUTIVE_MASTER_LIVE_COLUMNS.every((col) =>
      fields.some((f) => f.column === col)
    )
  );
  console.log(
    "sampleFilters:",
    fields
      .slice(0, 8)
      .map((f) => `${f.column}:${f.control}`)
      .join(", ")
  );

  const page1 = paginateExecutiveRows(projected.rows, 1, 20);
  console.log("page1:", {
    rows: page1.rows.length,
    total: page1.total,
    pageCount: page1.pageCount,
  });

  const activeOnly = applyExecutiveMasterFilters(projected.rows, {
    columnFilters: { "Job Status": ["Active"] },
    textFilters: {},
    dateFilters: {},
  });
  console.log("filteredActiveTotal:", activeOnly.length);

  const jdSearch = applyExecutiveMasterFilters(projected.rows, {
    columnFilters: {},
    textFilters: { "Job Description": "manage" },
    dateFilters: {},
  });
  console.log("jdTextSearchTotal:", jdSearch.length);

  const posted = [
    ...new Set(
      projected.rows
        .map((r) =>
          r.Posted === null || r.Posted === undefined ? "" : String(r.Posted)
        )
        .filter((v) => v.length > 0)
    ),
  ].sort();
  console.log("postedValues:", posted.join(", "));

  const statuses = [
    ...new Set(
      projected.rows
        .map((r) =>
          r["Job Status"] === null || r["Job Status"] === undefined
            ? ""
            : String(r["Job Status"])
        )
        .filter(Boolean)
    ),
  ].sort();
  console.log("jobStatusValues:", statuses.join(", "));

  const buffer = await buildMasterSheetXlsxBuffer({
    sheetName: EXECUTIVE_MASTER_SHEET_NAME,
    headers: [...projected.headers],
    rows: projected.rows,
  });
  console.log("exportBytes:", buffer.length);
  console.log("PHASE2B_SMOKE_OK");
}

main().catch((err) => {
  console.error("PHASE2B_SMOKE_FAIL", err);
  process.exit(1);
});
