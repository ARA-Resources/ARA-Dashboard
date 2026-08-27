/**
 * Phase 2A focused validation for Executive Master Sheet local read.
 * Usage (from ara-dashboard): npx tsx scripts/validate-executive-master-phase2a.ts
 *
 * Does not print absolute paths, Drive IDs, or secrets.
 */
import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  assertExecutiveMasterHeaders,
  EXECUTIVE_MASTER_HEADER_ROW,
  EXECUTIVE_MASTER_LIVE_COLUMNS,
  EXECUTIVE_MASTER_SHEET_NAME,
  projectExecutiveMasterLiveColumns,
} from "../src/services/excel/executive-master-sheet";
import { parseWorksheet } from "../src/services/excel/parse-sheet";
import { resolveReadableExcelPath } from "../src/services/excel/readable-workbook";

async function resolveWorkbookPath(): Promise<{
  filePath: string;
  sourceKind: "local" | "bundled";
  sourceFile: string;
}> {
  const fromEnv = (process.env.ARA_EXECUTIVE_EXCEL_PATH ?? "").trim();
  if (fromEnv) {
    await fs.access(fromEnv);
    return {
      filePath: fromEnv,
      sourceKind: "local",
      sourceFile: path.basename(fromEnv),
    };
  }
  const bundled = path.join(
    process.cwd(),
    "data",
    "excel",
    "executive-mastersheet.xlsm"
  );
  await fs.access(bundled);
  return {
    filePath: bundled,
    sourceKind: "bundled",
    sourceFile: path.basename(bundled),
  };
}

async function main() {
  const resolved = await resolveWorkbookPath();
  const readable = await resolveReadableExcelPath(resolved.filePath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(readable);

  const sheet =
    workbook.worksheets.find(
      (item) =>
        item.name.trim().toLowerCase() ===
        EXECUTIVE_MASTER_SHEET_NAME.toLowerCase()
    ) ?? null;

  if (!sheet) {
    throw new Error(
      `Master Sheet not found. Available: ${workbook.worksheets
        .map((s) => s.name)
        .join(", ")}`
    );
  }

  const parsed = parseWorksheet(sheet, {
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

  const status = new Set<string>();
  const posted = new Set<string>();
  const priority = new Set<string>();
  const levels = new Set<string>();
  let jd = 0;
  let must = 0;
  let jr = 0;

  for (const row of projected.rows) {
    if (row["Job Requisition ID"]) jr += 1;
    if (row["Job Description"]) jd += 1;
    if (row["Must Have skills"]) must += 1;
    if (row["Job Status"]) status.add(String(row["Job Status"]));
    if (row["Posted"] !== null && row["Posted"] !== undefined) {
      posted.add(String(row["Posted"]));
    }
    if (row["Priority"]) priority.add(String(row["Priority"]));
    if (row["Level"] !== null && row["Level"] !== undefined) {
      levels.add(String(row["Level"]));
    }
  }

  const issues: string[] = [];
  if (projected.headers.length !== EXECUTIVE_MASTER_LIVE_COLUMNS.length) {
    issues.push("header count mismatch");
  }
  if (projected.rows.length === 0) issues.push("zero rows");
  if (jr === 0) issues.push("no Job Requisition ID values");
  if (jd === 0) issues.push("no Job Description values");
  if (!status.has("Active") || !status.has("Closed")) {
    issues.push("missing Active/Closed status");
  }
  if (!posted.has("Yes") || !posted.has("-")) {
    issues.push("missing Posted Yes/-");
  }
  for (const level of [
    "5-Associate Director",
    "6-Senior Manager",
    "7-Manager",
  ]) {
    if (!levels.has(level)) issues.push(`missing Level ${level}`);
  }

  const summary = {
    ok: issues.length === 0,
    sourceKind: resolved.sourceKind,
    sourceFile: resolved.sourceFile,
    sheetName: parsed.sheetName,
    headerRow: parsed.headerRow,
    headers: projected.headers,
    rowCount: projected.rows.length,
    jobRequisitionIdReadable: jr > 0,
    jobDescriptionReadable: jd > 0,
    mustHaveSkillsReadable: must > 0,
    jobStatusValues: [...status].sort(),
    postedValues: [...posted].sort(),
    priorityValues: [...priority].sort(),
    levelValues: [...levels].sort(),
    issues,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Executive Master validation failed."
  );
  process.exit(1);
});
