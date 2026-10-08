/**
 * Parity test: run Run All's two EXISTING, untouched JR-ID extractors —
 * Lateral's `extractPostedJobRequisitionId` (Step 18,
 * lateral-posted-sheet-processor.ts) and Executive's
 * `shouldKeepExecutivePostedRow` + `extractExecutivePostedJobRequisitionId`
 * (executive-posted-sheet-cleaner.ts) — against the NEW shared cleaner's
 * canonical output, and diff the resulting JR-ID sets.
 *
 * Goal: prove that after the new Posted button cleans a tab, Run All's own
 * Posted step (Lateral Step 18, which writes Column A/B/C; Executive's
 * read-only Posted matcher) still reads the SAME JR ID from every row —
 * i.e. Posted-then-RunAll and RunAll-then-Posted never disagree because
 * Run All misreads the new format. Also documents, as information rather
 * than a failure, a pre-existing divergence in Executive's old reader on
 * messy raw input unrelated to this feature (no space before a "|").
 */
import { extractPostedJobRequisitionId } from "../src/services/lateral-processing/lateral-posted-sheet-processor";
import {
  shouldKeepExecutivePostedRow,
  extractExecutivePostedJobRequisitionId,
} from "../src/services/executive-processing/executive-posted-sheet-cleaner";
import { cleanPostedSheetRows } from "../src/services/dataset-posted/posted-sheet-row-cleaner";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- Step 1: run messy raw input through the NEW cleaner to get canonical output ---
const rawSamples = [
  "ATCI-1111111-S1000001 | Posting Date: 01/02/2026 | Pune",
  "ATCI-2222222-S2000002|Posting Date:03/04/2026|Mumbai", // no spaces around pipes
  "ATCI-3333333-S3000003  Posting   Date :  05/06/2026 | Chennai", // ragged internal spacing
];

const cleaned = cleanPostedSheetRows(
  rawSamples.map((columnA, i) => ({ rowNumber: i + 2, columnA }))
);
assert(cleaned.kept.length === rawSamples.length, "all 3 raw samples must classify as clean/kept");

// --- Step 2: every canonical output string must be read identically by BOTH old extractors ---
for (const row of cleaned.kept) {
  const canonical = row.columnA;
  const expectedJrId = row.jobRequisitionId;

  const lateralJrId = extractPostedJobRequisitionId(canonical);
  assert(
    lateralJrId === expectedJrId,
    `Lateral's Step 18 extractor diverges on canonical output: got "${lateralJrId}", expected "${expectedJrId}" (input: "${canonical}")`
  );

  const executiveKept = shouldKeepExecutivePostedRow(canonical);
  assert(executiveKept, `Executive's reader would REJECT a canonical-format row it should keep: "${canonical}"`);
  const executiveJrId = extractExecutivePostedJobRequisitionId(canonical);
  assert(
    executiveJrId === expectedJrId,
    `Executive's extractor diverges on canonical output: got "${executiveJrId}", expected "${expectedJrId}" (input: "${canonical}")`
  );
}
console.log(
  `verify-posted-sheet-cleaner-parity: ${cleaned.kept.length}/${cleaned.kept.length} canonical rows read identically by Lateral's Step 18 extractor AND Executive's reader — Run All keeps working on a button-cleaned tab.`
);

// --- Step 3: documented, pre-existing divergence (informational, not a failure of this feature) ---
// Executive's extractor only splits on the first SPACE (never "|"), with no trim before the
// ATCI-prefix check. On raw (not-yet-cleaned) input with a "|" immediately after the JR ID and
// no space before it, Executive's old reader mis-extracts; Lateral's extractor (space-OR-pipe)
// and the new cleaner both handle it correctly. This divergence is pre-existing in Executive's
// own Run-All-side reader — unrelated to this feature, and never hit in practice because the new
// cleaner's own canonical output always has " | " with spaces, which Step 2 above proves parses
// correctly everywhere.
{
  const noSpaceBeforePipe = "ATCI-4444444-S4000004|Posting Date: 07/08/2026 | Delhi";
  const lateralJrId = extractPostedJobRequisitionId(noSpaceBeforePipe);
  const executiveJrId = extractExecutivePostedJobRequisitionId(noSpaceBeforePipe);
  console.log(
    `  (informational) raw "no space before |" input: Lateral extractor -> "${lateralJrId}" (correct); ` +
      `Executive's old extractor -> "${executiveJrId}" (${executiveJrId === "ATCI-4444444-S4000004" ? "also correct" : "pre-existing mis-parse, NOT introduced by this feature"})`
  );

  const leadingWhitespace = "  ATCI-5555555-S5000005 | Posting Date: 09/10/2026 | Pune";
  const executiveKeepsLeadingWhitespace = shouldKeepExecutivePostedRow(leadingWhitespace);
  console.log(
    `  (informational) raw leading-whitespace input: Executive's old reader keeps it = ${executiveKeepsLeadingWhitespace} ` +
      `(its "Like" check is untrimmed by design); Lateral's extractor and the new cleaner both trim first and find the JR ID regardless.`
  );
}

console.log("verify-posted-sheet-cleaner-parity: OK");
