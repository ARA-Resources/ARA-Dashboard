/**
 * Verify NEW Master Sheet row insertion rules (header-name map, append, Col K=New).
 * Run: npx tsx scripts/verify-lateral-new-row-insertion.ts
 */
import {
  buildNewToMasterHeaderMappings,
  planNewMasterRowInsertion,
  validateNewRowInsertions,
  MASTER_JOB_STATUS_COLUMN_K,
} from "../src/services/lateral-processing/lateral-new-row-insertion";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Master headers intentionally DIFFERENT order from New Sheet (position ≠ name)
const masterHeaders = [
  "Date", // A
  "Job Requisition ID", // B
  "Priority", // C
  "Job Description", // D
  "Skill Categorization", // E
  "Primary Skills", // F
  "Job Management Level", // G
  "Primary Location", // H — alias of New Sheet "Primary Location/Office Locate"
  "Market Map", // I
  "POC", // J
  "Job Status", // K
  "Master Only Extra", // L — no New Sheet counterpart
];

const newSheetHeaders = [
  "POC", // A — different position than Master
  "Job Requisition ID", // B
  "Date", // C
  "Priority", // D
  "Job Description", // E
  "Skill Categorization", // F
  "Primary Skills", // G
  "Job Management Level", // H
  "Primary Location/Office Locate", // I
  "Market Map", // J
];

const mappings = buildNewToMasterHeaderMappings({
  masterHeaders,
  newSheetHeaders,
});

assert(mappings.length >= 11, "mappings cover Master headers");

const jrMap = mappings.find((m) => m.masterHeader === "Job Requisition ID");
assert(jrMap?.masterCol === 2, "JR maps to Master col B");
assert(jrMap?.newSheetCol === 2, "JR maps to New Sheet col B by name");
assert(jrMap?.leaveBlank === false, "JR is not leaveBlank");

const dateMap = mappings.find((m) => m.masterHeader === "Date");
assert(dateMap?.masterCol === 1, "Date Master col A");
assert(dateMap?.newSheetCol === 3, "Date New Sheet col C (not position-matched)");

const locMap = mappings.find((m) => m.masterHeader === "Primary Location");
assert(locMap?.newSheetHeader === "Primary Location/Office Locate", "location alias");
assert(locMap?.newSheetCol === 9, "location New Sheet col I");

const statusMap = mappings.find(
  (m) => m.masterCol === MASTER_JOB_STATUS_COLUMN_K
);
assert(statusMap?.leaveBlank === true, "Job Status never mapped from New Sheet");
assert(statusMap?.newSheetCol === null, "no New Sheet status col");

const extra = mappings.find((m) => m.masterHeader === "Master Only Extra");
assert(extra?.leaveBlank === true, "Master-only field left blank");
assert(extra?.newSheetCol === null, "Master-only has no New Sheet col");

const plan = planNewMasterRowInsertion({
  jobRequisitionId: "JR-100",
  storedJobRequisitionId: "JR-100",
  newSheetRowNumber: 5,
  masterAppendRowNumber: 10,
  mappings,
});

assert(
  plan.fieldCopies.every((c) => c.masterCol !== MASTER_JOB_STATUS_COLUMN_K),
  "plan never copies status"
);
assert(
  plan.leftBlankMasterHeaders.includes("Master Only Extra"),
  "extra left blank in plan"
);
assert(
  plan.fieldCopies.some(
    (c) =>
      c.masterHeader === "Primary Location" &&
      c.newSheetHeader === "Primary Location/Office Locate"
  ),
  "plan copies location via alias"
);

// Validation: happy path
const okResult = validateNewRowInsertions({
  intendedNewIds: ["JR-100"],
  masterRowsByNormalizedId: { "JR-100": [10] },
  statusByMasterRow: { 10: "New" },
  cellsByMasterRow: {
    2: { 1: "01-01-2026", 2: "JR-OLD", 11: "Active" },
    10: {
      1: "12-08-2026",
      2: "JR-100",
      3: "P1",
      4: "Desc",
      8: "BLR",
      11: "New",
    },
  },
  existingRowsBeforeInsert: {
    2: { 1: "01-01-2026", 2: "JR-OLD", 11: "Active" },
  },
  plans: [
    {
      ...plan,
      fieldCopies: [
        {
          masterHeader: "Date",
          masterCol: 1,
          newSheetHeader: "Date",
          newSheetCol: 3,
        },
        {
          masterHeader: "Job Requisition ID",
          masterCol: 2,
          newSheetHeader: "Job Requisition ID",
          newSheetCol: 2,
        },
        {
          masterHeader: "Priority",
          masterCol: 3,
          newSheetHeader: "Priority",
          newSheetCol: 4,
        },
        {
          masterHeader: "Job Description",
          masterCol: 4,
          newSheetHeader: "Job Description",
          newSheetCol: 5,
        },
        {
          masterHeader: "Primary Location",
          masterCol: 8,
          newSheetHeader: "Primary Location/Office Locate",
          newSheetCol: 9,
        },
      ],
    },
  ],
  newSheetCells: {
    5: {
      2: "JR-100",
      3: "12-08-2026",
      4: "P1",
      5: "Desc",
      9: "BLR",
    },
  },
});

assert(okResult.ok, `happy path failed: ${okResult.reasons.join("; ")}`);
assert(okResult.checks.jrIdInserted, "jr inserted");
assert(okResult.checks.correctColumnsPopulated, "columns ok");
assert(okResult.checks.columnKIsNew, "K=New");
assert(okResult.checks.noDuplicateJrId, "no dupes");
assert(okResult.checks.existingRowsUntouched, "existing untouched");

// Fail: Column K not New
const badK = validateNewRowInsertions({
  intendedNewIds: ["JR-100"],
  masterRowsByNormalizedId: { "JR-100": [10] },
  statusByMasterRow: { 10: "Active" },
  cellsByMasterRow: { 10: { 2: "JR-100", 11: "Active" } },
  existingRowsBeforeInsert: {},
  plans: [plan],
  newSheetCells: { 5: { 2: "JR-100" } },
});
assert(!badK.ok && !badK.checks.columnKIsNew, "must fail when K ≠ New");

// Fail: duplicate JR
const dup = validateNewRowInsertions({
  intendedNewIds: ["JR-100"],
  masterRowsByNormalizedId: { "JR-100": [9, 10] },
  statusByMasterRow: { 9: "New", 10: "New" },
  cellsByMasterRow: {
    9: { 2: "JR-100", 11: "New" },
    10: { 2: "JR-100", 11: "New" },
  },
  existingRowsBeforeInsert: {},
  plans: [plan],
  newSheetCells: { 5: { 2: "JR-100" } },
});
assert(!dup.ok && !dup.checks.noDuplicateJrId, "must fail on duplicate JR");

// Fail: existing row touched
const touched = validateNewRowInsertions({
  intendedNewIds: ["JR-200"],
  masterRowsByNormalizedId: { "JR-200": [11] },
  statusByMasterRow: { 11: "New" },
  cellsByMasterRow: {
    2: { 2: "JR-OLD", 11: "Closed" },
    11: { 2: "JR-200", 11: "New" },
  },
  existingRowsBeforeInsert: {
    2: { 2: "JR-OLD", 11: "Active" },
  },
  plans: [
    {
      ...plan,
      jobRequisitionId: "JR-200",
      storedJobRequisitionId: "JR-200",
      masterAppendRowNumber: 11,
      fieldCopies: [],
    },
  ],
  newSheetCells: { 5: { 2: "JR-200" } },
});
assert(
  !touched.ok && !touched.checks.existingRowsUntouched,
  "must fail when existing row modified"
);

console.log("verify-lateral-new-row-insertion: OK");
