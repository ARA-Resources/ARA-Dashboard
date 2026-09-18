/**
 * Verify isRecoverableLateralSyncItemStatus() — the classification behind
 * the "continue to next candidate" fix. Only a failure intrinsic to ONE
 * candidate's content (bad file, missing ATCI DS, unreadable workbook) is
 * recoverable (skip-and-continue); everything else (Drive upload, Master
 * Workbook / New Sheet discovery, attachment download) stays a hard stop —
 * and anything unrecognized must default to non-recoverable (fail closed).
 */
import { isRecoverableLateralSyncItemStatus } from "../src/services/lateral-processing/lateral-failure-handling";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const RECOVERABLE = [
  "validation_failed",
  "source_sheet_missing",
  "source_read_failed",
];

const NON_RECOVERABLE = [
  "upload_failed",
  "master_discovery_failed",
  "new_sheet_structure_failed",
  "download_failed",
  "no_excel_attachment",
];

for (const status of RECOVERABLE) {
  assert(
    isRecoverableLateralSyncItemStatus(status) === true,
    `"${status}" must be recoverable (content-specific to one candidate)`
  );
}

for (const status of NON_RECOVERABLE) {
  assert(
    isRecoverableLateralSyncItemStatus(status) === false,
    `"${status}" must be non-recoverable (shared resource / infra, not this candidate)`
  );
}

// Fail closed: an unrecognized/future status must default to non-recoverable,
// never silently skipped.
assert(
  isRecoverableLateralSyncItemStatus("some_future_status_nobody_classified_yet") ===
    false,
  "an unrecognized status must default to non-recoverable (fail closed)"
);
assert(
  isRecoverableLateralSyncItemStatus("") === false,
  "an empty status must default to non-recoverable (fail closed)"
);

console.log("verify-lateral-failure-recoverability: OK");
