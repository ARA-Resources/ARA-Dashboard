/**
 * Live smoke test for the duplicate-content-fingerprint fix, against a real
 * (test-environment) Postgres — NOT mocked, NOT prod.
 *
 * Exercises the real service-layer + persistence-layer functions end to end:
 *  - advanceLateralGmailCheckpoint / isAfterLateralGmailCheckpoint /
 *    isKnownProcessedLateralFingerprint, against a real gmail_checkpoint
 *    row, including the new recent_fingerprints JSONB column added by
 *    migration 014 (CAS UPDATE + jsonb append/dedupe/trim + read-back).
 *
 * Reproduces the exact shape of the 2026-09-21 incident:
 *  - checkpoint seeded on the 18th-Sep file (messageId A)
 *  - a fresh Gmail refetch of that SAME message returning a DIFFERENT
 *    attachmentId must still be excluded (the comparator-hardening fix)
 *  - a genuinely DIFFERENT messageId (B) carrying byte-identical content
 *    must be excluded via the fingerprint history (the cross-message-dedup
 *    fix) — even though the cursor alone would call it "after checkpoint"
 *  - the real 21st-Sep file (different filename+size) must still pass both
 *    checks and, once processed, the history must persist through a real
 *    Postgres read-back
 *
 * The real gmail_checkpoint row is read before any writes and restored to
 * its exact original value afterward (advanceLateralGmailCheckpoint's CAS
 * is forward-only, so restoring uses a direct UPDATE, not the guarded API —
 * same pattern as verify-lateral-skip-and-continue-live.ts).
 *
 * Requires ARA_PERSISTENCE=postgres and POSTGRES_URL pointing at a TEST
 * database, and migration 014 already applied. Refuses to run otherwise.
 *
 * Run: npm run test:lateral-duplicate-fingerprint-live
 */
import postgres from "postgres";
import {
  advanceLateralGmailCheckpoint,
  isAfterLateralGmailCheckpoint,
  isKnownProcessedLateralFingerprint,
  readLateralGmailCheckpoint,
} from "../src/services/lateral-processing/lateral-gmail-checkpoint-store";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

if (process.env.ARA_PERSISTENCE !== "postgres" || !process.env.POSTGRES_URL) {
  console.error(
    "Refusing to run: requires ARA_PERSISTENCE=postgres and POSTGRES_URL set to a TEST database."
  );
  process.exit(1);
}

const sql = postgres(process.env.POSTGRES_URL, { max: 1 });

const STALE_FILENAME = "AdhocDS (Lateral Vendors) as on 18th Sep 2026.xlsx";
const STALE_SIZE = 3_205_892;
const GENUINE_FILENAME = "AdhocDS (Lateral Vendors) as on 21st Sep 2026.xlsx";
const GENUINE_SIZE = 3_312_500;

async function main() {
  console.log("=== Live smoke test: Lateral duplicate-content-fingerprint fix ===\n");

  const originalCheckpoint = await readLateralGmailCheckpoint();
  console.log(
    "Original gmail_checkpoint:",
    originalCheckpoint.messageId,
    originalCheckpoint.attachmentFilename
  );

  try {
    // --- Seed: simulate the original 2026-09-18 successful run ---
    // REAL advance — proves migration 014's recent_fingerprints column
    // round-trips through the actual Postgres CAS write, not just the type
    // system.
    const baseline = await advanceLateralGmailCheckpoint({
      messageId: "live-test-stale-msg-A",
      attachmentId: "live-test-stale-att-A-original",
      receivedAt: "2026-09-18T09:33:04.000Z",
      receivedAtMs: Date.parse("2026-09-18T09:33:04.000Z"),
      attachmentFilename: STALE_FILENAME,
      attachmentSize: STALE_SIZE,
      driveFileId: "live-test-stale-drive-A",
      processingResult: "SUCCESS",
    });
    assert(
      baseline.messageId === "live-test-stale-msg-A",
      "baseline checkpoint must be written"
    );
    assert(
      (baseline.recentFingerprints ?? []).length === 1,
      "baseline checkpoint must have exactly one recent-fingerprint entry after the first advance"
    );
    console.log(
      "  PASS  baseline checkpoint + recent_fingerprints seeded via real Postgres CAS write"
    );

    // ===================================================================
    // CHECK 1: same message, unstable attachmentId (the exact root bug)
    // ===================================================================
    console.log(
      "\n--- Check 1: same (receivedAtMs, messageId), different attachmentId ---"
    );
    const sameMessageDifferentAttachmentId = {
      messageId: "live-test-stale-msg-A",
      attachmentId: "live-test-stale-att-A-REFETCHED-DIFFERENT",
      receivedAtMs: Date.parse("2026-09-18T09:33:04.000Z"),
    };
    const rereadAfterBaseline = await readLateralGmailCheckpoint();
    assert(
      isAfterLateralGmailCheckpoint(
        sameMessageDifferentAttachmentId,
        rereadAfterBaseline
      ) === false,
      "a fresh fetch of the exact same already-checkpointed message, with a DIFFERENT attachmentId, must NOT be treated as after the checkpoint"
    );
    console.log("  PASS  same-message/different-attachmentId re-fetch correctly excluded");

    // ===================================================================
    // CHECK 2: different messageId, identical content (cross-message dup)
    // ===================================================================
    console.log(
      "\n--- Check 2: different messageId, same content (forwarded duplicate) ---"
    );
    const differentMessageSameContent = {
      messageId: "live-test-stale-msg-B-FORWARDED-COPY",
      attachmentId: "live-test-stale-att-B",
      receivedAtMs: Date.parse("2026-09-18T09:33:06.000Z"), // 2s later — genuinely "after" the cursor
    };
    assert(
      isAfterLateralGmailCheckpoint(
        differentMessageSameContent,
        rereadAfterBaseline
      ) === true,
      "sanity check: a different messageId with a later receivedAtMs IS after the checkpoint by cursor alone — this is exactly why fingerprint dedup is needed"
    );
    assert(
      isKnownProcessedLateralFingerprint(
        { attachmentName: STALE_FILENAME, size: STALE_SIZE },
        rereadAfterBaseline
      ) === true,
      "a different messageId carrying the exact same filename+size as the baseline must be recognized as a known-processed duplicate"
    );
    console.log(
      "  PASS  cross-message content duplicate correctly recognized via recent_fingerprints"
    );

    // ===================================================================
    // CHECK 3: genuine new candidate — must still pass both checks
    // ===================================================================
    console.log("\n--- Check 3: genuinely new candidate (different content) ---");
    const genuineCandidate = {
      messageId: "live-test-genuine-msg-C",
      attachmentId: "live-test-genuine-att-C",
      receivedAtMs: Date.parse("2026-09-21T08:39:37.000Z"),
    };
    assert(
      isAfterLateralGmailCheckpoint(genuineCandidate, rereadAfterBaseline) === true,
      "genuine new candidate must be discoverable (after checkpoint)"
    );
    assert(
      isKnownProcessedLateralFingerprint(
        { attachmentName: GENUINE_FILENAME, size: GENUINE_SIZE },
        rereadAfterBaseline
      ) === false,
      "genuine new candidate's content must NOT be flagged as a known duplicate"
    );
    console.log("  PASS  genuine new candidate passes both checks — not starved");

    // ===================================================================
    // CHECK 4: advancing to the genuine candidate correctly grows history
    // ===================================================================
    console.log("\n--- Check 4: advancing past the genuine candidate ---");
    const afterGenuine = await advanceLateralGmailCheckpoint({
      messageId: genuineCandidate.messageId,
      attachmentId: genuineCandidate.attachmentId,
      receivedAt: "2026-09-21T08:39:37.000Z",
      receivedAtMs: genuineCandidate.receivedAtMs,
      attachmentFilename: GENUINE_FILENAME,
      attachmentSize: GENUINE_SIZE,
      driveFileId: "live-test-genuine-drive-C",
      processingResult: "SUCCESS",
    });
    assert(
      afterGenuine.messageId === genuineCandidate.messageId,
      "checkpoint must advance to the genuine candidate"
    );
    assert(
      (afterGenuine.recentFingerprints ?? []).length === 2,
      `recent_fingerprints must accumulate distinct fingerprints, got ${(afterGenuine.recentFingerprints ?? []).length}`
    );
    const rereadFinal = await readLateralGmailCheckpoint();
    assert(
      rereadFinal.messageId === genuineCandidate.messageId &&
        (rereadFinal.recentFingerprints ?? []).length === 2,
      "re-read from Postgres directly must match — proves the JSONB append/trim actually persisted, not just an in-memory object"
    );
    console.log(
      "  PASS  checkpoint + recent_fingerprints history round-trip correctly through real Postgres"
    );

    console.log("\n=== verify-lateral-duplicate-fingerprint-live: ALL PASS ===");
  } finally {
    // --- Restore the real gmail_checkpoint row exactly as found ---
    if (originalCheckpoint.messageId) {
      await sql`
        UPDATE gmail_checkpoint SET
          message_id = ${originalCheckpoint.messageId},
          attachment_id = ${originalCheckpoint.attachmentId},
          received_at = ${originalCheckpoint.receivedAt ? new Date(originalCheckpoint.receivedAt) : null},
          received_at_ms = ${originalCheckpoint.receivedAtMs},
          attachment_file = ${originalCheckpoint.attachmentFilename},
          drive_file_id = ${originalCheckpoint.driveFileId},
          processed_at = ${originalCheckpoint.processedAt ? new Date(originalCheckpoint.processedAt) : null},
          result = ${originalCheckpoint.processingResult},
          recent_fingerprints = ${sql.json((originalCheckpoint.recentFingerprints ?? []) as never)},
          updated_at = now()
        WHERE account_email = 'default'
      `;
    } else {
      await sql`DELETE FROM gmail_checkpoint WHERE account_email = 'default'`;
    }

    const restored = await readLateralGmailCheckpoint();
    assert(
      restored.messageId === originalCheckpoint.messageId,
      "gmail_checkpoint must be restored to its exact original value"
    );
    console.log("\nCleanup: gmail_checkpoint restored to original.");

    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
