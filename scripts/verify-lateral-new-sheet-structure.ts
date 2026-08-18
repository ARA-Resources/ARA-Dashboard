/**
 * Verify New Sheet exact A–J header structure validation.
 * Run: npx tsx scripts/verify-lateral-new-sheet-structure.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  columnLetterFromIndex,
  EXPECTED_NEW_SHEET_HEADERS,
  LateralNewSheetStructureError,
  readNewSheetRow1HeadersFromLocal,
  validateNewSheetHeaderStructure,
} from "../src/services/lateral-processing/lateral-new-sheet-structure";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function main() {
  assert(EXPECTED_NEW_SHEET_HEADERS.length === 10, "A–J is 10 columns");
  assert(EXPECTED_NEW_SHEET_HEADERS[0] === "Date", "A=Date");
  assert(EXPECTED_NEW_SHEET_HEADERS[1] === "Job Requisition ID", "B");
  assert(EXPECTED_NEW_SHEET_HEADERS[7] === "Primary Location/Office Locate", "H");
  assert(EXPECTED_NEW_SHEET_HEADERS[9] === "POC", "J");
  assert(columnLetterFromIndex(0) === "A", "col A");
  assert(columnLetterFromIndex(9) === "J", "col J");

  const ok = validateNewSheetHeaderStructure([...EXPECTED_NEW_SHEET_HEADERS]);
  assert(ok.ok, "exact match must pass");
  assert(ok.differences.length === 0, "no diffs");

  const swapped = [...EXPECTED_NEW_SHEET_HEADERS];
  swapped[1] = "Priority";
  swapped[2] = "Job Requisition ID";
  const badOrder = validateNewSheetHeaderStructure(swapped);
  assert(!badOrder.ok, "reordered headers must fail");
  assert(
    badOrder.differences.some((d) => d.column === "B"),
    "reports column B"
  );
  assert(
    badOrder.differences.some((d) => d.column === "C"),
    "reports column C"
  );
  assert(/expected "Job Requisition ID"/.test(badOrder.message), "shows expected");
  assert(/actual "Priority"/.test(badOrder.message), "shows actual");
  assert(/were not rearranged/.test(badOrder.message), "states no rearrange");

  const missing = validateNewSheetHeaderStructure(
    EXPECTED_NEW_SHEET_HEADERS.slice(0, 8)
  );
  assert(!missing.ok, "missing I/J must fail");
  assert(
    missing.differences.some((d) => d.column === "I"),
    "reports missing I"
  );

  const typo = [...EXPECTED_NEW_SHEET_HEADERS] as string[];
  typo[7] = "Primary Location/Office locate"; // casing only — must pass
  const caseOk = validateNewSheetHeaderStructure(typo);
  assert(caseOk.ok, "case-insensitive H header must pass (locate vs Locate)");

  const wrongWord = [...EXPECTED_NEW_SHEET_HEADERS] as string[];
  wrongWord[7] = "Primary Location/Office Location"; // different word — fail
  const wrongResult = validateNewSheetHeaderStructure(wrongWord);
  assert(!wrongResult.ok, "different H wording must fail");
  assert(
    wrongResult.differences.some(
      (d) =>
        d.column === "H" &&
        d.expected === "Primary Location/Office Locate"
    ),
    "H difference reported"
  );

  // Row 1 from real workbook file
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lateral-new-sheet-"));
  const goodPath = path.join(dir, "master.xlsx");
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("New Sheet");
  sheet.addRow([...EXPECTED_NEW_SHEET_HEADERS]);
  sheet.addRow(["2026-08-12", "J1", "P1", "desc", "cat", "skills", "L1", "BLR", "MM", "poc"]);
  await wb.xlsx.writeFile(goodPath);

  const headers = await readNewSheetRow1HeadersFromLocal(goodPath, "New Sheet");
  assert(
    validateNewSheetHeaderStructure(headers).ok,
    "row 1 from workbook must validate"
  );

  const badPath = path.join(dir, "bad.xlsx");
  const wb2 = new ExcelJS.Workbook();
  const badSheet = wb2.addWorksheet("New Sheet");
  badSheet.addRow([
    "Date",
    "Priority", // wrong position
    "Job Requisition ID",
    "Job Description",
    "Skill Categorization",
    "Primary Skills",
    "Job Management Level",
    "Primary Location/Office Locate",
    "Market Map",
    "POC",
  ]);
  await wb2.xlsx.writeFile(badPath);
  const badHeaders = await readNewSheetRow1HeadersFromLocal(badPath, "New Sheet");
  const badValidation = validateNewSheetHeaderStructure(badHeaders);
  assert(!badValidation.ok, "bad workbook must fail");
  try {
    if (!badValidation.ok) throw new LateralNewSheetStructureError(badValidation);
    assert(false, "should throw");
  } catch (error) {
    assert(
      error instanceof LateralNewSheetStructureError,
      "typed structure error"
    );
  }

  await fs.rm(dir, { recursive: true, force: true });
  console.log("verify-lateral-new-sheet-structure: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
