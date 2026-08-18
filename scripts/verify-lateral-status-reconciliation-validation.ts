/**
 * Verify complete status reconciliation validation.
 * Run: npx tsx scripts/verify-lateral-status-reconciliation-validation.ts
 */
import {
  findStatusesOutsideColumnK,
  validateCompleteStatusReconciliation,
} from "../src/services/lateral-processing/lateral-status-reconciliation-validation";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const today = "13-08-2026";

const happy = validateCompleteStatusReconciliation({
  todayDDMMYYYY: today,
  masterRows: [
    {
      jobRequisitionId: "JR-A",
      masterRowNumber: 2,
      presentInNewSheet: true,
      presentInMasterSheetBefore: true,
      previousStatus: "Active",
      finalStatus: "Active",
      finalDate: "01-01-2026",
      reportedAction: "Activated",
    },
    {
      jobRequisitionId: "JR-C",
      masterRowNumber: 3,
      presentInNewSheet: false,
      presentInMasterSheetBefore: true,
      previousStatus: "Active",
      finalStatus: "Closed",
      finalDate: "02-02-2026",
      reportedAction: "Closed",
    },
    {
      jobRequisitionId: "JR-R",
      masterRowNumber: 4,
      presentInNewSheet: true,
      presentInMasterSheetBefore: true,
      previousStatus: "Closed",
      finalStatus: "Reopen",
      finalDate: today,
      reportedAction: "Reopened",
    },
    {
      jobRequisitionId: "JR-N",
      masterRowNumber: 5,
      presentInNewSheet: true,
      presentInMasterSheetBefore: false,
      previousStatus: "",
      finalStatus: "New",
      finalDate: today,
      reportedAction: "Added",
    },
  ],
  masterCellsByRow: {
    2: { 2: "JR-A", 11: "Active", 4: "Some description" },
    3: { 2: "JR-C", 11: "Closed", 4: "Other" },
    4: { 2: "JR-R", 11: "Reopen", 1: today },
    5: { 2: "JR-N", 11: "New", 1: today },
  },
  masterHeadersByCol: {
    1: "Date",
    2: "Job Requisition ID",
    4: "Job Description",
    11: "Job Status",
  },
});

assert(happy.ok, `happy path failed: ${happy.reasons.join("; ")}`);
assert(happy.statusCounts.Active === 1, "Active count");
assert(happy.statusCounts.Closed === 1, "Closed count");
assert(happy.statusCounts.Reopen === 1, "Reopen count");
assert(happy.statusCounts.New === 1, "New count");
assert(happy.actionCounts.newRowsAdded === 1, "new rows added");
assert(happy.actionCounts.reopenedRows === 1, "reopened rows");
assert(happy.actionCounts.rowsClosed === 1, "rows closed");
assert(happy.actionCounts.rowsRemainingActive === 1, "rows remaining active");
assert(happy.checks.statusesOnlyInColumnK, "statuses only in K");
assert(happy.checks.reopenDatesAreToday, "reopen dates");
assert(happy.checks.columnKPerStatus, "column K per status");
assert(happy.jrResults.every((r) => r.ok), "every JR ok");

// Fail: Reopen date not today
const badReopenDate = validateCompleteStatusReconciliation({
  todayDDMMYYYY: today,
  masterRows: [
    {
      jobRequisitionId: "JR-R",
      masterRowNumber: 4,
      presentInNewSheet: true,
      presentInMasterSheetBefore: true,
      previousStatus: "Closed",
      finalStatus: "Reopen",
      finalDate: "01-01-2020",
      reportedAction: "Reopened",
    },
  ],
});
assert(!badReopenDate.ok && !badReopenDate.checks.reopenDatesAreToday, "fail reopen date");

// Fail: New without Column K = New
const badNew = validateCompleteStatusReconciliation({
  todayDDMMYYYY: today,
  masterRows: [
    {
      jobRequisitionId: "JR-N",
      masterRowNumber: 5,
      presentInNewSheet: true,
      presentInMasterSheetBefore: false,
      previousStatus: "",
      finalStatus: "Active",
      finalDate: today,
      reportedAction: "Added",
    },
  ],
});
assert(!badNew.ok, "fail New Column K");

// Fail: Closed without Column K = Closed
const badClosed = validateCompleteStatusReconciliation({
  todayDDMMYYYY: today,
  masterRows: [
    {
      jobRequisitionId: "JR-C",
      masterRowNumber: 3,
      presentInNewSheet: false,
      presentInMasterSheetBefore: true,
      previousStatus: "Active",
      finalStatus: "Active",
      finalDate: "02-02-2026",
      reportedAction: "Closed",
    },
  ],
});
assert(!badClosed.ok, "fail Closed Column K");

// Fail: Active without Column K = Active
const badActive = validateCompleteStatusReconciliation({
  todayDDMMYYYY: today,
  masterRows: [
    {
      jobRequisitionId: "JR-A",
      masterRowNumber: 2,
      presentInNewSheet: true,
      presentInMasterSheetBefore: true,
      previousStatus: "New",
      finalStatus: "New",
      finalDate: "01-01-2026",
      reportedAction: "Activated",
    },
  ],
});
assert(!badActive.ok, "fail Active Column K");

// Fail: status leaked outside Column K
const leaks = findStatusesOutsideColumnK({
  masterCellsByRow: {
    2: { 4: "Active", 11: "Active" },
  },
  masterHeadersByCol: { 4: "Job Description", 11: "Job Status" },
  jobIdByRow: { 2: "JR-A" },
});
assert(leaks.length === 1 && leaks[0].column === 4, "detect leak");

// Column L (12) is a filter column — Active there must NOT count as a leak
const ignoreL = findStatusesOutsideColumnK({
  masterCellsByRow: {
    52: { 11: "Active", 12: "Active" },
  },
  masterHeadersByCol: { 11: "Job Status", 12: "Opened on Oorwin" },
  jobIdByRow: { 52: "ATCI-4825637-S1848115" },
});
assert(ignoreL.length === 0, "Column L filter Active must be ignored");

const badLeak = validateCompleteStatusReconciliation({
  todayDDMMYYYY: today,
  masterRows: [
    {
      jobRequisitionId: "JR-A",
      masterRowNumber: 2,
      presentInNewSheet: true,
      presentInMasterSheetBefore: true,
      previousStatus: "Active",
      finalStatus: "Active",
      finalDate: "01-01-2026",
      reportedAction: "Activated",
    },
  ],
  masterCellsByRow: {
    2: { 4: "Closed", 11: "Active" },
  },
  masterHeadersByCol: { 4: "Priority", 11: "Job Status" },
});
assert(!badLeak.ok && !badLeak.checks.statusesOnlyInColumnK, "fail status leak");

// Fail: wrong action
const badAction = validateCompleteStatusReconciliation({
  todayDDMMYYYY: today,
  masterRows: [
    {
      jobRequisitionId: "JR-A",
      masterRowNumber: 2,
      presentInNewSheet: true,
      presentInMasterSheetBefore: true,
      previousStatus: "Active",
      finalStatus: "Active",
      finalDate: "01-01-2026",
      reportedAction: "Closed",
    },
  ],
});
assert(!badAction.ok && !badAction.checks.actionsCorrect, "fail wrong action");

console.log("verify-lateral-status-reconciliation-validation: OK");
