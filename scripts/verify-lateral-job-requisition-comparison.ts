/**
 * Verify Job Requisition comparison engine (ID-only, duplicates stop, no status changes).
 * Run: npx tsx scripts/verify-lateral-job-requisition-comparison.ts
 */
import {
  collectJobRequisitionOccurrences,
  compareJobRequisitionsById,
  JOB_REQUISITION_ID_HEADER,
  normalizeJobRequisitionIdForComparison,
} from "../src/services/lateral-processing/lateral-job-requisition-comparison";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(
  normalizeJobRequisitionIdForComparison("  JR-100  ") === "JR-100",
  "trim whitespace for comparison"
);
assert(
  normalizeJobRequisitionIdForComparison("JR-100") === "JR-100",
  "exact id unchanged"
);

const headers = ["Date", JOB_REQUISITION_ID_HEADER, "Primary Skills", "Job Description"];

const newCollected = collectJobRequisitionOccurrences({
  sheet: "New Sheet",
  headers,
  dataRows: [
    ["12-08-2026", " JR-1 ", "Java", "desc A"],
    ["12-08-2026", "JR-2", "Python", "desc B"],
    ["12-08-2026", "JR-3", "Go", "desc C"],
  ],
});
assert(newCollected.ok === true, "collect new");
if (newCollected.ok) {
  assert(newCollected.occurrences[0].storedValue === " JR-1 ", "stored value preserved");
  assert(newCollected.occurrences[0].normalizedId === "JR-1", "normalized for match");
}

const masterCollected = collectJobRequisitionOccurrences({
  sheet: "Master Sheet",
  headers: ["Job Requisition ID", "Job Status", "Date"],
  dataRows: [
    ["JR-2", "Active", "01-08-2026"],
    ["JR-3", "Closed", "01-07-2026"],
    ["JR-9", "Active", "01-06-2026"],
  ],
});
assert(masterCollected.ok === true, "collect master");

const comparison = compareJobRequisitionsById({
  newSheetOccurrences: newCollected.ok ? newCollected.occurrences : [],
  masterSheetOccurrences: masterCollected.ok ? masterCollected.occurrences : [],
});
assert(comparison.ok === true, "comparison ok");
if (comparison.ok) {
  assert(comparison.statusesChanged === false, "no status changes");
  assert(comparison.matchingKey === JOB_REQUISITION_ID_HEADER, "JR key only");
  assert(comparison.onlyInNew.map((e) => e.normalizedId).join() === "JR-1", "only in new");
  assert(comparison.onlyInMaster.map((e) => e.normalizedId).join() === "JR-9", "only in master");
  assert(
    comparison.inBoth.map((e) => e.normalizedId).sort().join() === "JR-2,JR-3",
    "in both"
  );
  // Must not match by skills/description — those differ but JR-2 still in_both
  assert(
    comparison.inBoth.find((e) => e.normalizedId === "JR-2")?.category === "in_both",
    "matched by JR id despite other field differences"
  );
}

// Duplicates in New Sheet → STOP
const dupNew = collectJobRequisitionOccurrences({
  sheet: "New Sheet",
  headers,
  dataRows: [
    ["12-08-2026", "JR-DUP", "a", "x"],
    ["12-08-2026", " JR-DUP ", "b", "y"],
  ],
});
assert(dupNew.ok === true, "dup collect");
const dupFail = compareJobRequisitionsById({
  newSheetOccurrences: dupNew.ok ? dupNew.occurrences : [],
  masterSheetOccurrences: masterCollected.ok ? masterCollected.occurrences : [],
});
assert(dupFail.ok === false, "duplicates must stop");
if (!dupFail.ok) {
  assert(dupFail.code === "DUPLICATES", "duplicate code");
  assert(/Duplicate Job Requisition IDs/.test(dupFail.message), "reports duplicates");
  assert(/New Sheet/.test(dupFail.message), "names sheet");
  assert(/Do not silently choose/.test(dupFail.message), "no silent pick");
  assert(dupFail.duplicates[0].occurrences.length === 2, "both occurrences listed");
}

// Duplicates in Master Sheet → STOP
const dupMaster = collectJobRequisitionOccurrences({
  sheet: "Master Sheet",
  headers: ["Job Requisition ID", "Job Status"],
  dataRows: [
    ["JR-M", "Active"],
    ["JR-M", "Closed"],
  ],
});
const dupMasterFail = compareJobRequisitionsById({
  newSheetOccurrences: newCollected.ok ? newCollected.occurrences : [],
  masterSheetOccurrences: dupMaster.ok ? dupMaster.occurrences : [],
});
assert(dupMasterFail.ok === false, "master duplicates stop");
if (!dupMasterFail.ok) {
  assert(/Master Sheet/.test(dupMasterFail.message), "reports master sheet");
}

console.log("verify-lateral-job-requisition-comparison: OK");
