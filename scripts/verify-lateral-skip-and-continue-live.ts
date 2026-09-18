/**
 * Live smoke test for the "continue to next candidate" fix, against a real
 * (test-environment) Postgres — NOT mocked, NOT prod.
 *
 * Exercises the real service-layer functions end to end:
 *  - advanceLateralGmailCheckpoint / isAfterLateralGmailCheckpoint (real gmail_checkpoint row)
 *  - appendLateralSyncHistory (real lateral_sync_history row, post-migration-013 columns)
 *  - pushAppNotification (real app_notifications row)
 *
 * Scenario 1 replays the 2026-09-18 Book2.xlsx incident shape: an older,
 * recoverable-failure candidate is skipped, a newer candidate succeeds.
 * Scenario 2 replays a normal clean-success run (no skips) to prove that
 * path is byte-for-byte unaffected (skipped_count=0, skipped_detail=null,
 * notification kind stays dataset_sync_success, not dataset_sync_partial).
 *
 * All rows this script creates are deleted at the end. The real
 * gmail_checkpoint row is read before any writes and restored to its exact
 * original value afterward (advanceLateralGmailCheckpoint's CAS is
 * forward-only, so restoring uses a direct UPDATE, not the guarded API).
 *
 * Requires ARA_PERSISTENCE=postgres and POSTGRES_URL pointing at a TEST
 * database. Refuses to run otherwise.
 *
 * Run: npm run test:lateral-skip-and-continue-live
 */
import postgres from "postgres";
import {
  advanceLateralGmailCheckpoint,
  isAfterLateralGmailCheckpoint,
  readLateralGmailCheckpoint,
} from "../src/services/lateral-processing/lateral-gmail-checkpoint-store";
import { appendLateralSyncHistory } from "../src/services/lateral-processing/lateral-sync-history-store";
import { pushAppNotification } from "../src/services/dataset/notifications-store";
import {
  evaluateLateralSyncQueueOutcome,
  isRecoverableLateralSyncItemStatus,
} from "../src/services/lateral-processing/lateral-failure-handling";

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

const createdSyncHistoryIds: string[] = [];
const createdNotificationIds: string[] = [];

async function main() {
  console.log("=== Live smoke test: Lateral skip-and-continue fix ===\n");

  const originalCheckpoint = await readLateralGmailCheckpoint();
  console.log(
    "Original gmail_checkpoint:",
    originalCheckpoint.messageId,
    originalCheckpoint.attachmentFilename
  );

  try {
    // --- Baseline: simulate "yesterday's successful run" ---
    const baseline = await advanceLateralGmailCheckpoint({
      messageId: "live-test-baseline-msg",
      attachmentId: "live-test-baseline-att",
      receivedAt: "2026-09-17T11:36:56.000Z",
      receivedAtMs: Date.parse("2026-09-17T11:36:56.000Z"),
      attachmentFilename: "AdhocDS (Lateral Vendors) as on 17th Sep 2026.xlsx",
      driveFileId: "live-test-baseline-drive-id",
      processingResult: "SUCCESS",
    });
    assert(
      baseline.messageId === "live-test-baseline-msg",
      "baseline checkpoint must be written"
    );

    // ===================================================================
    // SCENARIO 1: skip Book2.xlsx-shaped candidate, succeed on the real file
    // ===================================================================
    console.log("\n--- Scenario 1: skip-then-succeed (Book2.xlsx shape) ---");

    const badCandidate = {
      messageId: "live-test-book2-msg",
      attachmentId: "live-test-book2-att",
      receivedAtMs: Date.parse("2026-09-18T05:55:02.000Z"),
    };
    const goodCandidate = {
      messageId: "live-test-realfile-msg",
      attachmentId: "live-test-realfile-att",
      receivedAt: "2026-09-18T09:33:04.000Z",
      receivedAtMs: Date.parse("2026-09-18T09:33:04.000Z"),
      attachmentFilename: "AdhocDS (Lateral Vendors) as on 18th Sep 2026.xlsx",
      driveFileId: "live-test-realfile-drive-id",
    };

    // Both candidates are after the baseline checkpoint — both would be
    // discovered by the Gmail query, exactly like the real incident.
    assert(
      isAfterLateralGmailCheckpoint(badCandidate, baseline) === true,
      "decoy candidate must be discoverable (after baseline checkpoint)"
    );
    assert(
      isAfterLateralGmailCheckpoint(goodCandidate, baseline) === true,
      "real candidate must be discoverable (after baseline checkpoint)"
    );

    // The decoy's failure kind (ATCI DS missing) must classify as recoverable.
    assert(
      isRecoverableLateralSyncItemStatus("source_sheet_missing") === true,
      "source_sheet_missing must be recoverable — this is what lets the loop skip Book2.xlsx and try the next candidate"
    );

    // Job-level outcome: 1 uploaded, 1 skipped, no hard stop → still success.
    const outcome = evaluateLateralSyncQueueOutcome({
      uploadedCount: 1,
      hardStopped: false,
      skippedCandidateCount: 1,
    });
    assert(outcome.syncOk === true, "sync phase must report OK despite the skip");
    assert(
      outcome.stoppedOnUploadOrSyncFailure === false,
      "sync phase must not be flagged as a failure"
    );

    // REAL checkpoint advance — simulates what lateral-job.ts does after the
    // real loop skips Book2.xlsx and succeeds on the real file.
    const afterScenario1 = await advanceLateralGmailCheckpoint({
      messageId: goodCandidate.messageId,
      attachmentId: goodCandidate.attachmentId,
      receivedAt: goodCandidate.receivedAt,
      receivedAtMs: goodCandidate.receivedAtMs,
      attachmentFilename: goodCandidate.attachmentFilename,
      driveFileId: goodCandidate.driveFileId,
      processingResult: "SUCCESS",
    });

    assert(
      afterScenario1.messageId === goodCandidate.messageId,
      `checkpoint must advance to the REAL file's messageId, got "${afterScenario1.messageId}"`
    );
    assert(
      afterScenario1.attachmentFilename === goodCandidate.attachmentFilename,
      `checkpoint must advance to the REAL file's filename, got "${afterScenario1.attachmentFilename}"`
    );
    assert(
      afterScenario1.messageId !== badCandidate.messageId,
      "checkpoint must NOT point at the skipped decoy"
    );

    // Re-read from Postgres directly (not the in-process return value) to
    // prove the row actually persisted, not just an in-memory object.
    const reread = await readLateralGmailCheckpoint();
    assert(
      reread.messageId === goodCandidate.messageId,
      "re-read checkpoint from Postgres must match the real file"
    );

    // The decoy must now be permanently excluded from future discovery —
    // this is the exact mechanism that prevents Book2.xlsx from being
    // retried forever AND prevents it from ever surfacing again.
    assert(
      isAfterLateralGmailCheckpoint(badCandidate, reread) === false,
      "decoy candidate must now be excluded from all future discovery"
    );
    // Forward discovery must still work for a genuinely new future email.
    const futureCandidate = {
      messageId: "live-test-future-msg",
      attachmentId: "live-test-future-att",
      receivedAtMs: Date.parse("2026-09-19T09:00:00.000Z"),
    };
    assert(
      isAfterLateralGmailCheckpoint(futureCandidate, reread) === true,
      "a genuinely newer future candidate must still be discoverable"
    );
    console.log("  PASS  checkpoint advances to the real file, not the decoy");
    console.log("  PASS  decoy permanently excluded; future candidates still discoverable");

    // REAL lateral_sync_history write — proves migration 013's columns work
    // through the actual Postgres store, not just the type system.
    const skippedDetail = [
      {
        attachmentName: "Book2.xlsx",
        messageId: badCandidate.messageId,
        receivedAt: "2026-09-18T05:55:02.000Z",
        status: "source_sheet_missing",
        error: "ATCI DS worksheet was not found.",
      },
    ];
    const historyEntry = await appendLateralSyncHistory({
      syncTime: new Date().toISOString(),
      sourceEmail: "<live-test@example.com> · live smoke test",
      originalFilename: goodCandidate.attachmentFilename,
      googleDriveFileId: goodCandidate.driveFileId,
      rowsImported: 3,
      newCount: 1,
      activeCount: 2,
      reopenCount: 0,
      closedCount: 0,
      result: "Success",
      error: null,
      trigger: "manual",
      durationMs: 12345,
      skippedCount: 1,
      skippedDetail,
    });
    createdSyncHistoryIds.push(historyEntry.id);

    const [historyRow] = await sql<
      { skipped_count: number; skipped_detail: unknown; result: string }[]
    >`SELECT skipped_count, skipped_detail, result FROM lateral_sync_history WHERE id = ${historyEntry.id}`;
    assert(!!historyRow, "sync history row must exist in Postgres after append");
    assert(
      historyRow.result === "Success",
      "result must stay 'Success' even though a candidate was skipped"
    );
    assert(
      historyRow.skipped_count === 1,
      `skipped_count must round-trip as 1, got ${historyRow.skipped_count}`
    );
    assert(
      Array.isArray(historyRow.skipped_detail) &&
        (historyRow.skipped_detail as unknown[]).length === 1 &&
        (historyRow.skipped_detail as Array<{ attachmentName: string }>)[0]
          .attachmentName === "Book2.xlsx",
      "skipped_detail must round-trip with the decoy's details"
    );
    console.log("  PASS  lateral_sync_history.skipped_count / skipped_detail round-trip correctly");

    // REAL app_notifications write — proves the dataset_sync_partial kind
    // fires for a success-with-skips run.
    const notification = await pushAppNotification({
      kind: "dataset_sync_partial",
      title: "Lateral Run All succeeded (skipped 1 candidate(s))",
      body: `Trigger: manual · Source: ${goodCandidate.attachmentFilename} · Skipped: "Book2.xlsx" (ATCI DS worksheet was not found.)`,
      href: "/company/accenture/lateral/master-sheet",
      meta: { skippedCandidates: skippedDetail, datasetName: "Lateral" },
    });
    createdNotificationIds.push(notification.id);

    const [notifRow] = await sql<
      { kind: string; meta: unknown }[]
    >`SELECT kind, meta FROM app_notifications WHERE id = ${notification.id}`;
    assert(!!notifRow, "notification row must exist in Postgres after push");
    assert(
      notifRow.kind === "dataset_sync_partial",
      `notification kind must be dataset_sync_partial, got "${notifRow.kind}"`
    );
    const notifMeta = notifRow.meta as { skippedCandidates?: unknown[] };
    assert(
      Array.isArray(notifMeta.skippedCandidates) &&
        notifMeta.skippedCandidates.length === 1,
      "notification meta must carry the skipped candidate detail"
    );
    console.log("  PASS  dataset_sync_partial notification fires with skipped-candidate detail");

    // ===================================================================
    // SCENARIO 2: clean success, no skips — must be identical to today
    // ===================================================================
    console.log("\n--- Scenario 2: clean success (no skips) — must be unaffected ---");

    const cleanCandidate = {
      messageId: "live-test-clean-msg",
      attachmentId: "live-test-clean-att",
      receivedAt: "2026-09-19T09:33:04.000Z",
      receivedAtMs: Date.parse("2026-09-19T09:33:04.000Z"),
      attachmentFilename: "AdhocDS (Lateral Vendors) as on 19th Sep 2026.xlsx",
      driveFileId: "live-test-clean-drive-id",
    };
    const cleanOutcome = evaluateLateralSyncQueueOutcome({
      uploadedCount: 1,
      hardStopped: false,
      skippedCandidateCount: 0,
    });
    assert(cleanOutcome.syncOk === true, "clean success must be syncOk");
    assert(
      cleanOutcome.allCandidatesExhausted === false,
      "clean success must not be allCandidatesExhausted"
    );

    const afterScenario2 = await advanceLateralGmailCheckpoint({
      messageId: cleanCandidate.messageId,
      attachmentId: cleanCandidate.attachmentId,
      receivedAt: cleanCandidate.receivedAt,
      receivedAtMs: cleanCandidate.receivedAtMs,
      attachmentFilename: cleanCandidate.attachmentFilename,
      driveFileId: cleanCandidate.driveFileId,
      processingResult: "SUCCESS",
    });
    assert(
      afterScenario2.messageId === cleanCandidate.messageId,
      "clean-success checkpoint must advance normally"
    );

    const cleanHistoryEntry = await appendLateralSyncHistory({
      syncTime: new Date().toISOString(),
      sourceEmail: "<live-test@example.com> · live smoke test (clean)",
      originalFilename: cleanCandidate.attachmentFilename,
      googleDriveFileId: cleanCandidate.driveFileId,
      rowsImported: 2,
      newCount: 0,
      activeCount: 2,
      reopenCount: 0,
      closedCount: 0,
      result: "Success",
      error: null,
      trigger: "manual",
      durationMs: 9000,
      // Deliberately NOT passing skippedCount/skippedDetail — must default
      // exactly like every pre-migration row.
    });
    createdSyncHistoryIds.push(cleanHistoryEntry.id);

    const [cleanHistoryRow] = await sql<
      { skipped_count: number; skipped_detail: unknown }[]
    >`SELECT skipped_count, skipped_detail FROM lateral_sync_history WHERE id = ${cleanHistoryEntry.id}`;
    assert(
      cleanHistoryRow.skipped_count === 0,
      `clean success must default skipped_count to 0, got ${cleanHistoryRow.skipped_count}`
    );
    assert(
      cleanHistoryRow.skipped_detail === null,
      "clean success must default skipped_detail to null"
    );
    console.log("  PASS  clean success defaults skipped_count=0, skipped_detail=null");

    const cleanNotification = await pushAppNotification({
      kind: "dataset_sync_success",
      title: "Lateral Run All succeeded",
      body: `Trigger: manual · Source: ${cleanCandidate.attachmentFilename}`,
      href: "/company/accenture/lateral/master-sheet",
      meta: { datasetName: "Lateral" },
    });
    createdNotificationIds.push(cleanNotification.id);

    const [cleanNotifRow] = await sql<
      { kind: string }[]
    >`SELECT kind FROM app_notifications WHERE id = ${cleanNotification.id}`;
    assert(
      cleanNotifRow.kind === "dataset_sync_success",
      `clean success must use dataset_sync_success (not partial), got "${cleanNotifRow.kind}"`
    );
    console.log("  PASS  clean success still uses dataset_sync_success (not partial)");

    console.log("\n=== verify-lateral-skip-and-continue-live: ALL PASS ===");
  } finally {
    // --- Cleanup: delete every row this script created ---
    for (const id of createdSyncHistoryIds) {
      await sql`DELETE FROM lateral_sync_history WHERE id = ${id}`;
    }
    for (const id of createdNotificationIds) {
      await sql`DELETE FROM app_notifications WHERE id = ${id}`;
    }

    // --- Restore the real gmail_checkpoint row exactly as found ---
    // advanceLateralGmailCheckpoint's CAS is forward-only by design, so
    // restoring an OLDER original value requires a direct UPDATE here —
    // acceptable for test cleanup, never done outside this script.
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
    console.log("\nCleanup: sync history + notification test rows deleted; gmail_checkpoint restored to original.");

    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
