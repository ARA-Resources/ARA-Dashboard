/**
 * Verify final Master XLSM save validation gates.
 * Run: npx tsx scripts/verify-lateral-final-master-save.ts
 */
import {
  FINAL_MASTER_WORKBOOK_NAME,
  assertFinalSaveIsXlsm,
  validateFinalMasterWorkbookSave,
} from "../src/services/lateral-processing/lateral-final-master-save";
import { EXPECTED_NEW_SHEET_HEADERS } from "../src/services/lateral-processing/lateral-new-sheet-structure";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(
  FINAL_MASTER_WORKBOOK_NAME.endsWith(".xlsm"),
  "default master is xlsm"
);
assert(assertFinalSaveIsXlsm(FINAL_MASTER_WORKBOOK_NAME).ok, "accept xlsm");
assert(!assertFinalSaveIsXlsm("Master.xlsx").ok, "reject xlsx");
assert(!assertFinalSaveIsXlsm("Master.xls").ok, "reject xls");

const today = "13-08-2026";
const headers = [...EXPECTED_NEW_SHEET_HEADERS];

const happy = validateFinalMasterWorkbookSave({
  fileName: FINAL_MASTER_WORKBOOK_NAME,
  extension: ".xlsm",
  masterSheetName: "Master Sheet",
  newSheetName: "New Sheet",
  newSheetHeaders: headers,
  newSheetRows: [
    { date: today, jobRequisitionId: "JR-A" },
    { date: today, jobRequisitionId: "JR-R" },
    { date: today, jobRequisitionId: "JR-N" },
  ],
  masterHeaders: [
    "Date",
    "Job Requisition ID",
    "Priority",
    "Job Description",
    "Skill Categorization",
    "Primary Skills",
    "Job Management Level",
    "Primary Location/Office Locate",
    "Market Map",
    "POC",
    "Job Status",
  ],
  masterRows: [
    {
      rowNumber: 2,
      date: "01-01-2026",
      jobRequisitionId: "JR-A",
      status: "Active",
    },
    {
      rowNumber: 3,
      date: "02-02-2026",
      jobRequisitionId: "JR-C",
      status: "Closed",
    },
    {
      rowNumber: 4,
      date: today,
      jobRequisitionId: "JR-R",
      status: "Reopen",
    },
    {
      rowNumber: 5,
      date: today,
      jobRequisitionId: "JR-N",
      status: "New",
    },
  ],
  isXlsm: true,
  keepVbaTrue: true,
  todayDDMMYYYY: today,
  expectedClosedIds: ["JR-C"],
  expectedNewIds: ["JR-N"],
});

assert(happy.ok, `happy failed: ${happy.reasons.join("; ")}`);
assert(happy.checks.newSheetUpdated, "new sheet updated");
assert(happy.checks.newSheetHeadersUnchanged, "headers");
assert(happy.checks.newSheetDatePopulated, "dates");
assert(happy.checks.jrMappingSuccessful, "jr map");
assert(happy.checks.masterSheetUpdated, "master updated");
assert(happy.checks.columnKValidStatusesOnly, "col K");
assert(happy.checks.newRowsCorrectlyMapped, "new rows");
assert(happy.checks.reopenRowsHaveCurrentDate, "reopen date");
assert(happy.checks.closedRowsRemainInMaster, "closed remain");
assert(happy.checks.noDuplicateJrIds, "no dupes");
assert(happy.checks.workbookIsXlsm, "xlsm");
assert(happy.checks.vbaProjectPreservedHint, "vba");

const badXlsx = validateFinalMasterWorkbookSave({
  fileName: "Copy.xlsx",
  extension: ".xlsx",
  isXlsm: false,
  keepVbaTrue: false,
  masterSheetName: "Master Sheet",
  newSheetName: "New Sheet",
  newSheetHeaders: headers,
  newSheetRows: [{ date: today, jobRequisitionId: "JR-A" }],
  masterHeaders: [
    "Date",
    "Job Requisition ID",
    "Priority",
    "Job Description",
    "Skill Categorization",
    "Primary Skills",
    "Job Management Level",
    "Primary Location",
    "Market Map",
    "POC",
    "Job Status",
  ],
  masterRows: [
    {
      rowNumber: 2,
      date: today,
      jobRequisitionId: "JR-A",
      status: "Active",
    },
  ],
  todayDDMMYYYY: today,
});
assert(!badXlsx.ok && !badXlsx.checks.workbookIsXlsm, "reject xlsx save");

const badDup = validateFinalMasterWorkbookSave({
  fileName: FINAL_MASTER_WORKBOOK_NAME,
  extension: ".xlsm",
  isXlsm: true,
  keepVbaTrue: true,
  masterSheetName: "Master Sheet",
  newSheetName: "New Sheet",
  newSheetHeaders: headers,
  newSheetRows: [{ date: today, jobRequisitionId: "JR-A" }],
  masterHeaders: [
    "Date",
    "Job Requisition ID",
    "Priority",
    "Job Description",
    "Skill Categorization",
    "Primary Skills",
    "Job Management Level",
    "Primary Location/Office Locate",
    "Market Map",
    "POC",
    "Job Status",
  ],
  masterRows: [
    {
      rowNumber: 2,
      date: today,
      jobRequisitionId: "JR-A",
      status: "Active",
    },
    {
      rowNumber: 3,
      date: today,
      jobRequisitionId: "JR-A",
      status: "New",
    },
  ],
  todayDDMMYYYY: today,
});
assert(!badDup.ok && !badDup.checks.noDuplicateJrIds, "reject duplicate JR");

const badReopenDate = validateFinalMasterWorkbookSave({
  fileName: FINAL_MASTER_WORKBOOK_NAME,
  extension: ".xlsm",
  isXlsm: true,
  keepVbaTrue: true,
  masterSheetName: "Master Sheet",
  newSheetName: "New Sheet",
  newSheetHeaders: headers,
  newSheetRows: [{ date: today, jobRequisitionId: "JR-R" }],
  masterHeaders: [
    "Date",
    "Job Requisition ID",
    "Priority",
    "Job Description",
    "Skill Categorization",
    "Primary Skills",
    "Job Management Level",
    "Primary Location/Office Locate",
    "Market Map",
    "POC",
    "Job Status",
  ],
  masterRows: [
    {
      rowNumber: 2,
      date: "01-01-2020",
      jobRequisitionId: "JR-R",
      status: "Reopen",
    },
  ],
  todayDDMMYYYY: today,
});
assert(
  !badReopenDate.ok && !badReopenDate.checks.reopenRowsHaveCurrentDate,
  "reject stale reopen date"
);

const badClosedMissing = validateFinalMasterWorkbookSave({
  fileName: FINAL_MASTER_WORKBOOK_NAME,
  extension: ".xlsm",
  isXlsm: true,
  keepVbaTrue: true,
  masterSheetName: "Master Sheet",
  newSheetName: "New Sheet",
  newSheetHeaders: headers,
  newSheetRows: [{ date: today, jobRequisitionId: "JR-A" }],
  masterHeaders: [
    "Date",
    "Job Requisition ID",
    "Priority",
    "Job Description",
    "Skill Categorization",
    "Primary Skills",
    "Job Management Level",
    "Primary Location/Office Locate",
    "Market Map",
    "POC",
    "Job Status",
  ],
  masterRows: [
    {
      rowNumber: 2,
      date: today,
      jobRequisitionId: "JR-A",
      status: "Active",
    },
  ],
  todayDDMMYYYY: today,
  expectedClosedIds: ["JR-GONE"],
});
assert(
  !badClosedMissing.ok && !badClosedMissing.checks.closedRowsRemainInMaster,
  "reject missing closed row"
);

console.log("verify-lateral-final-master-save: OK");
