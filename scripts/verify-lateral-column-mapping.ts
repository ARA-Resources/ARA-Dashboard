/**
 * Verify ATCI DS → New Sheet header-name mapping.
 * Run: npx tsx scripts/verify-lateral-column-mapping.ts
 */
import {
  mapAtciDsToNewSheet,
  NEW_SHEET_TO_ATCI_DS_CANDIDATES,
} from "../src/services/lateral-processing/lateral-column-mapping";
import { EXPECTED_NEW_SHEET_HEADERS } from "../src/services/lateral-processing/lateral-new-sheet-structure";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const fullSource = [
  "Extra Col",
  "Job Requisition ID",
  "Priority",
  "Job Description",
  "Skill Categorization",
  "Primary Skills",
  "Job Management Level",
  "Primary Location", // ATCI DS common label
  "Market Map",
  "POC",
  "Another Extra",
];

const ok = mapAtciDsToNewSheet(fullSource);
assert(ok.ok === true, "full source must map");
if (ok.ok) {
  assert(ok.mappings.length === 10, "10 destination columns");
  assert(ok.mappings[0].generated === true, "Date is generated");
  assert(ok.mappings[0].sourceColIndex === -1, "Date has no source col");
  assert(
    ok.mappings[0].destinationHeader === "Date",
    "Date stays first (order preserved)"
  );
  assert(
    ok.explicitMappings[1].atciDsHeader === "Job Requisition ID" &&
      ok.explicitMappings[1].newSheetHeader === "Job Requisition ID",
    "explicit ATCI DS → New Sheet for Job Requisition ID"
  );
  assert(
    ok.mappings[7].sourceHeader === "Primary Location",
    "Primary Location/Office Locate matches Primary Location by name"
  );
  assert(
    ok.mappings[7].destinationHeader === "Primary Location/Office Locate",
    "destination header unchanged"
  );
  assert(
    ok.ignoredSourceHeaders.includes("Extra Col") &&
      ok.ignoredSourceHeaders.includes("Another Extra"),
    "extra source columns ignored — not added to New Sheet"
  );
  // Not mapped by position: Job Requisition ID is source index 1, dest index 1
  // Priority is source index 2 — if we mapped by position from col0 we'd be wrong
  assert(ok.mappings[1].sourceColIndex === 1, "name match, not position 0");
  assert(ok.mappings.every((m, i) => m.destinationColIndex === i), "dest order fixed");
}

// Missing required header → STOP details
const missingPriority = mapAtciDsToNewSheet(
  fullSource.filter((h) => h !== "Priority")
);
assert(missingPriority.ok === false, "missing Priority must fail");
if (!missingPriority.ok) {
  assert(missingPriority.missingHeaders.includes("Priority"), "reports Missing header");
  assert(
    /Missing header:.*Priority/i.test(missingPriority.message),
    "message shows Missing header"
  );
  assert(
    /Source headers found:/i.test(missingPriority.message),
    "message shows Source headers found"
  );
  assert(
    /Destination headers expected:/i.test(missingPriority.message),
    "message shows Destination headers expected"
  );
  assert(
    /Do NOT clear New Sheet/i.test(missingPriority.message),
    "must not clear New Sheet"
  );
  assert(
    missingPriority.destinationHeadersExpected.join("|") ===
      EXPECTED_NEW_SHEET_HEADERS.join("|"),
    "expected dest headers are canonical"
  );
}

// Date must not be required from ATCI DS
assert(NEW_SHEET_TO_ATCI_DS_CANDIDATES.Date === "generated", "Date generated");
const withoutDate = mapAtciDsToNewSheet(
  fullSource.filter((h) => h.toLowerCase() !== "date")
);
assert(withoutDate.ok === true, "ATCI DS without Date still maps");

// Reordered ATCI DS columns still map correctly by name
const reordered = [
  "POC",
  "Market Map",
  "Primary Location/Office Locate",
  "Job Management Level",
  "Primary Skills",
  "Skill Categorization",
  "Job Description",
  "Priority",
  "Job Requisition ID",
];
const reorderedMap = mapAtciDsToNewSheet(reordered);
assert(reorderedMap.ok === true, "reordered source still maps by name");
if (reorderedMap.ok) {
  assert(
    reorderedMap.mappings[1].sourceHeader === "Job Requisition ID" &&
      reorderedMap.mappings[1].sourceColIndex === 8,
    "Job Requisition ID found by name despite last position in source"
  );
  assert(
    reorderedMap.mappings[9].sourceHeader === "POC" &&
      reorderedMap.mappings[9].destinationColIndex === 9,
    "POC maps to column J, not source position 0"
  );
}

console.log("verify-lateral-column-mapping: OK");
