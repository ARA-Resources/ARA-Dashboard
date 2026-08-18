/**
 * Verify Lateral source workbook processing (ATCI DS by exact name, read-only).
 * Run: npx tsx scripts/verify-lateral-source-workbook.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  ATCI_DS_WORKSHEET_NOT_FOUND,
  findWorksheetByExactName,
  LateralSourceWorkbookError,
  processLateralSourceWorkbook,
  sourceWorksheetNotFoundMessage,
} from "../src/services/lateral-processing/lateral-source-workbook";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function writeSampleWorkbook(
  filePath: string,
  sheetNames: string[],
  options?: { putDataOn?: string }
) {
  const wb = new ExcelJS.Workbook();
  // Intentionally create Cover first so ATCI DS is NOT the first sheet.
  for (const name of sheetNames) {
    const ws = wb.addWorksheet(name);
    if (name === (options?.putDataOn ?? "ATCI DS")) {
      ws.addRow(["Job ID", "Role", "Location"]);
      ws.addRow(["J1", "Engineer", "Bangalore"]);
      ws.addRow(["J2", "Analyst", "Hyderabad"]);
      ws.addRow(["J3", "Manager", "Pune"]);
    } else {
      ws.addRow(["Other"]);
      ws.addRow(["x"]);
    }
  }
  await wb.xlsx.writeFile(filePath);
}

async function main() {
  assert(
    findWorksheetByExactName(["Cover", "ATCI DS", "Summary"], "ATCI DS") ===
      "ATCI DS",
    "exact match must find ATCI DS even when not first"
  );
  assert(
    findWorksheetByExactName(["Cover", "atci ds", "Summary"], "ATCI DS") ===
      null,
    "must NOT case-fold — exact name only"
  );
  assert(
    findWorksheetByExactName(["ATCI DS"], "Sheet1") === null,
    "missing sheet returns null"
  );
  assert(
    sourceWorksheetNotFoundMessage("ATCI DS") === ATCI_DS_WORKSHEET_NOT_FOUND,
    "canonical missing message"
  );

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lateral-source-"));
  const okPath = path.join(dir, "sample.xlsx");
  const missingPath = path.join(dir, "missing.xlsx");

  await writeSampleWorkbook(okPath, ["Cover", "Notes", "ATCI DS", "Extra"]);
  await writeSampleWorkbook(missingPath, ["Cover", "Notes", "Extra"], {
    putDataOn: "Notes",
  });

  const read = await processLateralSourceWorkbook({
    localPath: okPath,
    worksheetName: "ATCI DS",
    workbookFileName: "sample.xlsx",
  });

  assert(read.worksheetName === "ATCI DS", "opened ATCI DS");
  assert(read.availableWorksheets[0] === "Cover", "ATCI DS was not first sheet");
  assert(read.headers.join("|") === "Job ID|Role|Location", "header row");
  assert(read.rowCount === 3, "data row count");
  assert(read.colCount === 3, "column count");
  assert(read.dataRows[0][0] === "J1", "first data row");
  assert(read.dataRows.length === 3, "all data rows returned");

  let missingOk = false;
  try {
    await processLateralSourceWorkbook({
      localPath: missingPath,
      worksheetName: "ATCI DS",
    });
  } catch (error) {
    missingOk =
      error instanceof LateralSourceWorkbookError &&
      error.code === "WORKSHEET_NOT_FOUND" &&
      error.message === ATCI_DS_WORKSHEET_NOT_FOUND;
  }
  assert(missingOk, "must stop with exact ATCI DS not found message");

  await fs.rm(dir, { recursive: true, force: true });
  console.log("verify-lateral-source-workbook: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
