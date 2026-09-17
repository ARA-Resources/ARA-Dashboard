/**
 * Verify the Executive Posted Sheet raw-text cleaner against the confirmed
 * decompiled VBA logic (PostedJobsWorkDay, Module21) and real sampled data
 * shapes (no network, no I/O).
 */
import {
  shouldKeepExecutivePostedRow,
  extractExecutivePostedJobRequisitionId,
  cleanExecutivePostedRows,
  type ExecutivePostedRawRow,
} from "../src/services/executive-processing/executive-posted-sheet-cleaner";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- shouldKeepExecutivePostedRow: mirrors VBA `Value Like "ATCI*"` (no trim) ---
assert(shouldKeepExecutivePostedRow("ATCI-5678248-S2059207 | Posting Date: 09/16/2026 | Pune") === true, "real sample row must be kept");
assert(shouldKeepExecutivePostedRow("ATCI") === true, "bare ATCI must be kept");
assert(shouldKeepExecutivePostedRow("Not a job posting") === false, "non-ATCI text must be removed");
assert(shouldKeepExecutivePostedRow("") === false, "empty string must be removed");
assert(shouldKeepExecutivePostedRow(null) === false, "null must be removed");
assert(shouldKeepExecutivePostedRow(undefined) === false, "undefined must be removed");
assert(shouldKeepExecutivePostedRow(" ATCI-1-S1") === false, "leading whitespace must be removed — VBA Like does NOT trim first");
assert(shouldKeepExecutivePostedRow("atci-1-S1") === false, "lowercase must be removed — VBA Like is case-sensitive by default");
assert(shouldKeepExecutivePostedRow(12345) === false, "non-string values must be removed");

// --- extractExecutivePostedJobRequisitionId: trim THEN split on first space ---
assert(
  extractExecutivePostedJobRequisitionId("ATCI-5678248-S2059207 | Posting Date: 09/16/2026 | Pune") ===
    "ATCI-5678248-S2059207",
  "must extract ID before first space from real sample shape"
);
assert(
  extractExecutivePostedJobRequisitionId("  ATCI-1-S1 | extra  ") === "ATCI-1-S1",
  "must trim surrounding whitespace before extracting"
);
assert(
  extractExecutivePostedJobRequisitionId("ATCI-1-S1") === "ATCI-1-S1",
  "no space at all: whole trimmed string is the ID"
);
assert(extractExecutivePostedJobRequisitionId("") === "", "empty stays empty");
assert(extractExecutivePostedJobRequisitionId(null) === "", "null becomes empty string");

// --- cleanExecutivePostedRows: full combinator, order + demand passthrough ---
{
  const rows: ExecutivePostedRawRow[] = [
    { rowNumber: 2, columnA: "ATCI-5678248-S2059207 | Posting Date: 09/16/2026 | Pune", columnC: "Yes" },
    { rowNumber: 3, columnA: "Not a real posting", columnC: "Yes" },
    { rowNumber: 4, columnA: "ATCI-5679117-S2059209 | Posting Date: 09/16/2026 | Chennai", columnC: "No" },
    { rowNumber: 5, columnA: "", columnC: "" },
    { rowNumber: 6, columnA: " ATCI-leading-space | x", columnC: "Yes" },
    { rowNumber: 7, columnA: "ATCI-noSpaceAtAll", columnC: "Yes" },
  ];

  const result = cleanExecutivePostedRows(rows);

  assert(result.kept.length === 3, `expected 3 kept rows, got ${result.kept.length}`);
  assert(result.removed.length === 3, `expected 3 removed rows, got ${result.removed.length}`);

  assert(result.kept[0].rowNumber === 2, "order preserved: first kept row is rowNumber 2");
  assert(result.kept[0].jobRequisitionId === "ATCI-5678248-S2059207", "row2 ID extracted correctly");
  assert(result.kept[0].demand === "Yes", "row2 demand passed through unchanged");

  assert(result.kept[1].rowNumber === 4, "second kept row is rowNumber 4");
  assert(result.kept[1].jobRequisitionId === "ATCI-5679117-S2059209", "row4 ID extracted correctly");
  assert(result.kept[1].demand === "No", "row4 demand ('No') passed through unchanged, not dropped");

  assert(result.kept[2].rowNumber === 7, "third kept row is rowNumber 7 (no-space case)");
  assert(result.kept[2].jobRequisitionId === "ATCI-noSpaceAtAll", "row7 whole string is the ID when no space present");

  assert(result.removed.some((r) => r.rowNumber === 3), "non-ATCI row (3) must be removed");
  assert(result.removed.some((r) => r.rowNumber === 5), "empty row (5) must be removed");
  assert(
    result.removed.some((r) => r.rowNumber === 6),
    "leading-whitespace row (6) must be removed, matching VBA's untrimmed Like check"
  );
}

console.log("verify-executive-posted-sheet-cleaner: OK");
