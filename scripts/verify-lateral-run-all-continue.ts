/**
 * Verify evaluateLateralSyncQueueOutcome() — the job-level decision matrix
 * behind the "continue to next candidate" fix (2026-09-18 Book2.xlsx
 * incident). No real/mocked Gmail client needed: this is the pure function
 * lateral-job.ts calls with the discovery-queue loop's actual counters.
 *
 * Covers the four outcomes that matter for today's incident class:
 *  - clean success (no skips)
 *  - success WITH skips (the actual fix: candidate 1 fails, candidate 2
 *    succeeds — must still be reported as sync-phase success, not failure)
 *  - all candidates exhausted (every discovered candidate failed, none
 *    succeeded — a genuine failure, distinct from "no matching email")
 *  - hard stop (non-recoverable failure — unchanged existing behavior)
 */
import { evaluateLateralSyncQueueOutcome } from "../src/services/lateral-processing/lateral-failure-handling";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// --- Clean success: one candidate, no skips ---
{
  const result = evaluateLateralSyncQueueOutcome({
    uploadedCount: 1,
    hardStopped: false,
    skippedCandidateCount: 0,
  });
  assert(result.syncOk === true, "clean success must be syncOk");
  assert(
    result.allCandidatesExhausted === false,
    "clean success must not be allCandidatesExhausted"
  );
  assert(
    result.stoppedOnUploadOrSyncFailure === false,
    "clean success must not be stoppedOnUploadOrSyncFailure"
  );
}

// --- THE FIX: candidate 1 (Book2.xlsx) fails, candidate 2 (real file) succeeds ---
{
  const result = evaluateLateralSyncQueueOutcome({
    uploadedCount: 1,
    hardStopped: false,
    skippedCandidateCount: 1,
  });
  assert(
    result.syncOk === true,
    "success-with-skips must still be syncOk — this is the whole point of the fix"
  );
  assert(
    result.allCandidatesExhausted === false,
    "success-with-skips must not be allCandidatesExhausted (something DID succeed)"
  );
  assert(
    result.stoppedOnUploadOrSyncFailure === false,
    "success-with-skips must not be reported as a sync failure"
  );
}

// --- All candidates exhausted: every discovered candidate failed, none succeeded ---
{
  const result = evaluateLateralSyncQueueOutcome({
    uploadedCount: 0,
    hardStopped: false,
    skippedCandidateCount: 3,
  });
  assert(
    result.syncOk === false,
    "all-exhausted must not be syncOk — nothing was actually processed"
  );
  assert(
    result.allCandidatesExhausted === true,
    "3 skipped, 0 uploaded, no hard stop must be allCandidatesExhausted"
  );
  assert(
    result.stoppedOnUploadOrSyncFailure === true,
    "all-exhausted is a genuine sync-phase failure"
  );
}

// --- Hard stop: non-recoverable failure (e.g. Drive upload) — unchanged existing behavior ---
{
  const result = evaluateLateralSyncQueueOutcome({
    uploadedCount: 0,
    hardStopped: true,
    skippedCandidateCount: 0,
  });
  assert(result.syncOk === false, "hard stop must not be syncOk");
  assert(
    result.allCandidatesExhausted === false,
    "hard stop takes priority over allCandidatesExhausted classification"
  );
  assert(
    result.stoppedOnUploadOrSyncFailure === true,
    "hard stop must be stoppedOnUploadOrSyncFailure"
  );
}

// --- Hard stop after a prior skip (candidate 1 recoverable-fail, candidate 2 non-recoverable-fail) ---
{
  const result = evaluateLateralSyncQueueOutcome({
    uploadedCount: 0,
    hardStopped: true,
    skippedCandidateCount: 1,
  });
  assert(
    result.stoppedOnUploadOrSyncFailure === true,
    "a hard stop must still stop the run even if an earlier candidate was skipped first"
  );
  assert(
    result.allCandidatesExhausted === false,
    "hardStopped must take priority — this is a hard stop, not an exhausted-queue outcome"
  );
}

// --- No candidates at all (nothing matched) — must NOT be misreported as all-exhausted ---
{
  const result = evaluateLateralSyncQueueOutcome({
    uploadedCount: 0,
    hardStopped: false,
    skippedCandidateCount: 0,
  });
  assert(
    result.allCandidatesExhausted === false,
    "zero skipped + zero uploaded must not be allCandidatesExhausted (that's NO_MATCHING_EMAIL, a different terminal state)"
  );
  assert(
    result.stoppedOnUploadOrSyncFailure === false,
    "no matching email is not a failure"
  );
}

console.log("verify-lateral-run-all-continue: OK");
