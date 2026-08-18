/**
 * Verify Lateral Master Workbook discovery rules (no network).
 * Run: npx tsx scripts/verify-lateral-master-workbook-discovery.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  isRejectedNonMacroMasterCopy,
  isXlsmMasterFilename,
  LateralMasterDiscoveryError,
  matchesConfiguredMasterFileName,
  resolveExpectedMasterFileName,
  validateMasterAndNewSheets,
  validateMasterWorkbookLocalFile,
} from "../src/services/lateral-processing/lateral-master-workbook-discovery";
import { DEFAULT_LATERAL_MASTER_WORKBOOK_NAME } from "../src/types/lateral-processing-setup";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function main() {
  assert(
    isXlsmMasterFilename(DEFAULT_LATERAL_MASTER_WORKBOOK_NAME),
    "default master must be xlsm"
  );
  assert(
    isRejectedNonMacroMasterCopy(
      "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsx"
    ),
    "must reject xlsx copy"
  );
  assert(
    !isRejectedNonMacroMasterCopy(DEFAULT_LATERAL_MASTER_WORKBOOK_NAME),
    "xlsm is not rejected"
  );
  assert(
    matchesConfiguredMasterFileName(
      DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
      DEFAULT_LATERAL_MASTER_WORKBOOK_NAME
    ),
    "exact name match"
  );
  assert(
    !matchesConfiguredMasterFileName(
      "Copy of ATCI Lateral DS AI MasterSheet Final 2026 (1).xlsm",
      DEFAULT_LATERAL_MASTER_WORKBOOK_NAME
    ),
    "must not accept renamed suffixes"
  );
  assert(
    resolveExpectedMasterFileName({
      masterWorkbook: { fileId: "x", fileName: "" },
    }) === DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
    "falls back to default master name"
  );

  const bothOk = validateMasterAndNewSheets({
    availableWorksheets: ["Cover", "Master Sheet", "New Sheet", "Other"],
  });
  assert(bothOk.ok === true, "both sheets present");

  const missingNew = validateMasterAndNewSheets({
    availableWorksheets: ["Master Sheet", "Data"],
  });
  assert(missingNew.ok === false, "New Sheet missing");
  if (!missingNew.ok) {
    assert(missingNew.missing.includes("New Sheet"), "reports New Sheet");
  }

  const missingMaster = validateMasterAndNewSheets({
    availableWorksheets: ["New Sheet"],
  });
  assert(missingMaster.ok === false, "Master Sheet missing");

  // Local file: ATCI DS not first; Master Sheet + New Sheet present; exact xlsm name
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lateral-master-"));
  const masterPath = path.join(dir, DEFAULT_LATERAL_MASTER_WORKBOOK_NAME);
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Cover").addRow(["x"]);
  const master = wb.addWorksheet("Master Sheet");
  master.addRow(["Job Requisition ID", "Status"]);
  master.addRow(["1", "Active"]);
  const neu = wb.addWorksheet("New Sheet");
  neu.addRow(["Date", "Job Requisition ID"]);
  await wb.xlsx.writeFile(masterPath);

  const validated = await validateMasterWorkbookLocalFile({
    localPath: masterPath,
    expectedFileName: DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
  });
  assert(validated.masterSheet === "Master Sheet", "master sheet exact");
  assert(validated.newSheet === "New Sheet", "new sheet exact");

  // Missing New Sheet → STOP message
  const badPath = path.join(dir, DEFAULT_LATERAL_MASTER_WORKBOOK_NAME + ".bad");
  // Use a temp copy without New Sheet but still .xlsm name via rewrite
  const badName = DEFAULT_LATERAL_MASTER_WORKBOOK_NAME;
  const badFile = path.join(dir, "bad-folder", badName);
  await fs.mkdir(path.dirname(badFile), { recursive: true });
  const wb2 = new ExcelJS.Workbook();
  wb2.addWorksheet("Master Sheet").addRow(["A"]);
  wb2.addWorksheet("Other").addRow(["B"]);
  await wb2.xlsx.writeFile(badFile);

  let missingOk = false;
  try {
    await validateMasterWorkbookLocalFile({
      localPath: badFile,
      expectedFileName: DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
    });
  } catch (error) {
    missingOk =
      error instanceof LateralMasterDiscoveryError &&
      error.code === "SHEET_MISSING" &&
      /New Sheet/.test(error.message);
  }
  assert(missingOk, "must stop when New Sheet is missing");

  // XLSX name rejected
  let xlsxRejected = false;
  try {
    await validateMasterWorkbookLocalFile({
      localPath: path.join(dir, "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsx"),
      expectedFileName: DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
    });
  } catch (error) {
    xlsxRejected =
      error instanceof LateralMasterDiscoveryError &&
      (error.code === "XLSX_REJECTED" || error.code === "NOT_XLSM" || error.code === "NAME_MISMATCH");
  }
  // File may not exist — create it then retest
  if (!xlsxRejected) {
    const xlsxPath = path.join(
      dir,
      "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsx"
    );
    await wb.xlsx.writeFile(xlsxPath);
    try {
      await validateMasterWorkbookLocalFile({
        localPath: xlsxPath,
        expectedFileName: DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
      });
    } catch (error) {
      xlsxRejected =
        error instanceof LateralMasterDiscoveryError &&
        (error.code === "XLSX_REJECTED" ||
          error.code === "NOT_XLSM" ||
          error.code === "NAME_MISMATCH");
    }
  }
  assert(xlsxRejected, "must reject xlsx master copy");

  void badPath;
  await fs.rm(dir, { recursive: true, force: true });
  console.log("verify-lateral-master-workbook-discovery: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
