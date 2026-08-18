/**
 * Verify Reopen date update rules (Column K=Reopen, Date=DD-MM-YYYY for that row only).
 * Run: npx tsx scripts/verify-lateral-reopen-date-update.ts
 */
import {
  decideReopenDateUpdate,
  formatReopenDateDDMMYYYY,
  isValidReopenDateFormat,
  planReopenDateUpdates,
  validateReopenDateUpdates,
} from "../src/services/lateral-processing/lateral-reopen-date-update";
import { resolveLateralJobStatus } from "../src/services/lateral-processing/lateral-job-status-rules";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const today = "13-08-2026";
assert(isValidReopenDateFormat(today), "today format");
assert(isValidReopenDateFormat(formatReopenDateDDMMYYYY(new Date(2026, 7, 13))), "formatter");
assert(!isValidReopenDateFormat("2026-08-13"), "reject ISO");
assert(!isValidReopenDateFormat("13/08/2026"), "reject slash");

// Qualify: in both + Closed → apply
const apply = decideReopenDateUpdate({
  existsInNewSheet: true,
  existsInMasterSheet: true,
  existingMasterStatus: "Closed",
  todayDDMMYYYY: today,
});
assert(apply.apply === true, "reopen applies");
assert(apply.status === "Reopen", "status Reopen");
assert(apply.newDate === today, "date today");
assert(apply.createRow === false, "no duplicate row");

// Active in both → do NOT update date
const active = decideReopenDateUpdate({
  existsInNewSheet: true,
  existsInMasterSheet: true,
  existingMasterStatus: "Active",
  todayDDMMYYYY: today,
});
assert(active.apply === false, "Active no date update");

// Closed absent from New → do NOT update date via reopen path
const closedAbsent = decideReopenDateUpdate({
  existsInNewSheet: false,
  existsInMasterSheet: true,
  existingMasterStatus: "Closed",
  todayDDMMYYYY: today,
});
assert(closedAbsent.apply === false, "Closed-absent no reopen date");

const closedRule = resolveLateralJobStatus({
  existsInNewSheet: false,
  existsInMasterSheet: true,
  existingMasterStatus: "Active",
});
assert(closedRule?.updateDate === false, "Closed rule never updates date");
assert(closedRule?.createRow === false, "Closed rule no duplicate");

const activeRule = resolveLateralJobStatus({
  existsInNewSheet: true,
  existsInMasterSheet: true,
  existingMasterStatus: "Active",
});
assert(activeRule?.updateDate === false, "Active rule never updates date");
assert(activeRule?.createRow === false, "Active rule no duplicate");

const plans = planReopenDateUpdates({
  todayDDMMYYYY: today,
  rowsInBothSheets: [
    {
      jobRequisitionId: "JR-R1",
      masterRowNumber: 5,
      previousStatus: "Closed",
      previousDate: "01-01-2025",
    },
    {
      jobRequisitionId: "JR-A1",
      masterRowNumber: 3,
      previousStatus: "Active",
      previousDate: "15-03-2026",
    },
    {
      jobRequisitionId: "JR-N1",
      masterRowNumber: 4,
      previousStatus: "New",
      previousDate: "10-07-2026",
    },
  ],
});
assert(plans.length === 1, "only Closed→Reopen planned");
assert(plans[0].jobRequisitionId === "JR-R1", "planned JR-R1");
assert(plans[0].newDate === today, "planned date");
assert(plans[0].newStatus === "Reopen", "planned status");

// Happy-path validation
const ok = validateReopenDateUpdates({
  reopenedIds: ["JR-R1"],
  todayDDMMYYYY: today,
  plans,
  dateBeforeByMasterRow: {
    3: "15-03-2026",
    4: "10-07-2026",
    5: "01-01-2025",
    7: "20-02-2026", // closed-absent
  },
  dateByMasterRow: {
    3: "15-03-2026",
    4: "10-07-2026",
    5: today,
    7: "20-02-2026",
  },
  statusByMasterRow: {
    3: "Active",
    4: "Active",
    5: "Reopen",
    7: "Closed",
  },
  activeMasterRows: [3, 4],
  closedMasterRows: [7],
});
assert(ok.ok, `happy path: ${ok.reasons.join("; ")}`);
assert(ok.checks.columnKIsReopen, "K=Reopen");
assert(ok.checks.dateIsTodayDDMMYYYY, "date today");
assert(ok.checks.noDuplicateRow, "no dupe");
assert(ok.checks.activeDatesUntouched, "active dates");
assert(ok.checks.closedAbsentDatesUntouched, "closed dates");
assert(ok.checks.onlyReopenedGotDateUpdate, "only reopen date");

// Fail if Active date was touched
const badActive = validateReopenDateUpdates({
  reopenedIds: [],
  todayDDMMYYYY: today,
  plans: [],
  dateBeforeByMasterRow: { 3: "15-03-2026" },
  dateByMasterRow: { 3: today },
  statusByMasterRow: { 3: "Active" },
  activeMasterRows: [3],
  closedMasterRows: [],
});
assert(!badActive.ok && !badActive.checks.activeDatesUntouched, "fail Active date change");

// Fail if Closed-absent date was touched
const badClosed = validateReopenDateUpdates({
  reopenedIds: [],
  todayDDMMYYYY: today,
  plans: [],
  dateBeforeByMasterRow: { 7: "20-02-2026" },
  dateByMasterRow: { 7: today },
  statusByMasterRow: { 7: "Closed" },
  activeMasterRows: [],
  closedMasterRows: [7],
});
assert(
  !badClosed.ok && !badClosed.checks.closedAbsentDatesUntouched,
  "fail Closed-absent date change"
);

// Fail if reopened row missing today date
const badDate = validateReopenDateUpdates({
  reopenedIds: ["JR-R1"],
  todayDDMMYYYY: today,
  plans,
  dateBeforeByMasterRow: { 5: "01-01-2025" },
  dateByMasterRow: { 5: "01-01-2025" },
  statusByMasterRow: { 5: "Reopen" },
  activeMasterRows: [],
  closedMasterRows: [],
});
assert(!badDate.ok && !badDate.checks.dateIsTodayDDMMYYYY, "fail stale reopen date");

console.log("verify-lateral-reopen-date-update: OK");
