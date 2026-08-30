/**
 * Verify final Lateral Job Status rules (Master Sheet Column K).
 * Run: npx tsx scripts/verify-lateral-job-status-rules.ts
 */
import {
  MASTER_JOB_STATUS_COLUMN_K,
  resolveLateralJobStatus,
} from "../src/services/lateral-processing/lateral-job-status-rules";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(MASTER_JOB_STATUS_COLUMN_K === 11, "Column K = 11");

// RULE 1 — ACTIVE
const active = resolveLateralJobStatus({
  existsInNewSheet: true,
  existsInMasterSheet: true,
  existingMasterStatus: "Active",
});
assert(active?.status === "Active", "Rule 1 Active from Active");
assert(active?.createRow === false, "Rule 1 no duplicate row");
assert(active?.updateDate === false, "Rule 1 no date change");

const activeFromNew = resolveLateralJobStatus({
  existsInNewSheet: true,
  existsInMasterSheet: true,
  existingMasterStatus: "New",
});
assert(activeFromNew?.status === "New", "New stays New until changed by hand");
assert(activeFromNew?.action === "Unchanged", "New keep is Unchanged");
assert(activeFromNew?.updateDate === false, "New keep no date change");

const keepReopen = resolveLateralJobStatus({
  existsInNewSheet: true,
  existsInMasterSheet: true,
  existingMasterStatus: "Reopen",
});
assert(keepReopen?.status === "Reopen", "Reopen stays Reopen until changed by hand");
assert(keepReopen?.action === "Unchanged", "Reopen keep is Unchanged");
assert(keepReopen?.updateDate === false, "Reopen keep no date rewrite");

const activeFromEmpty = resolveLateralJobStatus({
  existsInNewSheet: true,
  existsInMasterSheet: true,
  existingMasterStatus: "",
});
assert(activeFromEmpty?.status === "Active", "Rule 1 Active when empty/not Closed");

// RULE 2 — REOPEN
const reopen = resolveLateralJobStatus({
  existsInNewSheet: true,
  existsInMasterSheet: true,
  existingMasterStatus: "Closed",
});
assert(reopen?.status === "Reopen", "Rule 2 Reopen");
assert(reopen?.updateDate === true, "Rule 2 updates date");
assert(reopen?.createRow === false, "Rule 2 no duplicate");

// RULE 3 — CLOSED
const closed = resolveLateralJobStatus({
  existsInNewSheet: false,
  existsInMasterSheet: true,
  existingMasterStatus: "Active",
});
assert(closed?.status === "Closed", "Rule 3 Closed");
assert(closed?.createRow === false, "Rule 3 keep row");
assert(closed?.updateDate === false, "Rule 3 no date update");

const closedFromReopen = resolveLateralJobStatus({
  existsInNewSheet: false,
  existsInMasterSheet: true,
  existingMasterStatus: "Reopen",
});
assert(closedFromReopen?.status === "Closed", "Rule 3 Closed from Reopen");
assert(closedFromReopen?.updateDate === false, "Rule 3 Closed from Reopen no date");

// RULE 4 — NEW
const neu = resolveLateralJobStatus({
  existsInNewSheet: true,
  existsInMasterSheet: false,
});
assert(neu?.status === "New", "Rule 4 New");
assert(neu?.createRow === true, "Rule 4 creates row");
assert(neu?.action === "Added", "Rule 4 action Added");

// Neither sheet
assert(
  resolveLateralJobStatus({
    existsInNewSheet: false,
    existsInMasterSheet: false,
  }) === null,
  "no-op when absent both"
);

console.log("verify-lateral-job-status-rules: OK");
