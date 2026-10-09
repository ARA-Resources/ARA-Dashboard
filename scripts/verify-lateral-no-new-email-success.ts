/**
 * Live smoke test for Release B Stage 1 — Lateral's NO_MATCHING_EMAIL branch
 * reports Success (not Failed), against a real (throwaway) Postgres — NOT
 * mocked, NOT prod. Uses the new, additive `deps.runSync` injection seam on
 * `executeLateralDatasetJob` / `invokeLateralJob` (lateral-job.ts,
 * lateral-scheduler.ts) to simulate three Gmail-sync outcomes without any
 * real Gmail/Drive credentials:
 *
 *  1. NO_MATCHING_EMAIL — must be Success everywhere (job outcome, sync
 *     history, lastRunSummary, panel label), must NOT send a bell
 *     notification, and gmail_checkpoint must be left untouched.
 *  2. ALL_CANDIDATES_EXHAUSTED — must stay Failed, MUST send a bell
 *     notification, sync history row = "Failed".
 *  3. A real hard failure (simulated GOOGLE_DRIVE_UPLOAD_FAILURE via
 *     hardStopped: true) — must stay Failed.
 *  4. NO_MATCHING_EMAIL with Lateral Dataset Setup NOT configured
 *     (processingSetup = null) — must STILL be Success. Proves the
 *     effectiveStatus branch order: NO_MATCHING_EMAIL is checked before
 *     !processingSetup, so "no new email" can never be reclassified as a
 *     setup-config problem.
 *
 * Requires ARA_PERSISTENCE=postgres and POSTGRES_URL pointing at a
 * THROWAWAY database. Refuses to run otherwise (same guard as the existing
 * -live.ts scripts in this directory).
 *
 * Run: npm run test:lateral-no-new-email-success
 */
import postgres from "postgres";
import {
  executeLateralDatasetJob,
  type LateralJobDeps,
} from "../src/services/lateral-processing/lateral-job";
import {
  invokeLateralJob,
  readLateralSchedulerConfig,
} from "../src/services/lateral-processing/lateral-scheduler";
import { readLateralGmailCheckpoint } from "../src/services/lateral-processing/lateral-gmail-checkpoint-store";
import { listLateralSyncHistory } from "../src/services/lateral-processing/lateral-sync-history-store";
import { listAppNotifications } from "../src/services/dataset/notifications-store";
import {
  writeLateralDataProcessingSetup,
  clearLateralDataProcessingSetup,
} from "../src/services/lateral-processing/setup-store";
import { createEmptyLateralDataProcessingSetup } from "../src/types/lateral-processing-setup";
import type { LateralIncrementalSyncResult } from "../src/services/lateral-processing/lateral-gmail-incremental-sync";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

if (process.env.ARA_PERSISTENCE !== "postgres" || !process.env.POSTGRES_URL) {
  console.error(
    "Refusing to run: requires ARA_PERSISTENCE=postgres and POSTGRES_URL set to a THROWAWAY database."
  );
  process.exit(1);
}

const sql = postgres(process.env.POSTGRES_URL, { max: 1 });

const FAKE_CHECKPOINT = {
  version: 1 as const,
  messageId: "relb-baseline-msg",
  attachmentId: "relb-baseline-att",
  receivedAt: "2026-10-07T04:30:00.000Z",
  receivedAtMs: Date.parse("2026-10-07T04:30:00.000Z"),
  attachmentFilename: "ATCI_Lateral_DS_07Oct2026.xlsx",
  driveFileId: "relb-fake-drive-file-id",
  processedAt: "2026-10-07T04:35:00.000Z",
  processingResult: "SUCCESS" as const,
  recentFingerprints: [],
  updatedAt: "2026-10-07T04:35:00.000Z",
};

function baseSyncResult(): LateralIncrementalSyncResult {
  return {
    checkpointBefore: FAKE_CHECKPOINT,
    checkpointAfter: FAKE_CHECKPOINT,
    query: "relb-fake-query",
    gmailKeywords: ["lateral"],
    syncPurpose: "full_pipeline",
    scannedMessages: 3,
    matchedAttachments: 0,
    processedCount: 0,
    uploadedCount: 0,
    failedCount: 0,
    stoppedOnFailure: false,
    hardStopped: false,
    skippedCandidates: [],
    items: [],
    warnings: [],
    message: "Scanned 3 message(s). No candidate attachments matched.",
    pendingCheckpointAdvances: [],
    lastSourceRead: null,
    lastMasterDiscovery: null,
  };
}

async function notificationCount(): Promise<number> {
  const rows = await listAppNotifications(200);
  return rows.length;
}

async function main() {
  console.log("=== Release B Stage 1 — Lateral no-new-email Success (live, throwaway Postgres) ===\n");

  // A valid-but-minimal processing setup so the job doesn't short-circuit on
  // "Lateral Dataset Setup is not configured" before ever reaching the
  // sync-outcome branches under test.
  await writeLateralDataProcessingSetup({
    ...createEmptyLateralDataProcessingSetup(),
    updatedAt: new Date().toISOString(),
  });

  const checkpointBeforeAll = await readLateralGmailCheckpoint();

  // --- Scenario 1: NO_MATCHING_EMAIL -> Success ---
  {
    console.log("--- Scenario 1: NO_MATCHING_EMAIL ---");
    const notifBefore = await notificationCount();

    const deps: LateralJobDeps = {
      runSync: async () => baseSyncResult(),
    };

    const { outcome } = await invokeLateralJob("manual", deps);

    assert(outcome.status === "success", `expected status success, got ${outcome.status}`);
    assert(
      outcome.failure?.code === "NO_MATCHING_EMAIL",
      `expected outcome.failure.code NO_MATCHING_EMAIL, got ${outcome.failure?.code}`
    );
    assert(
      outcome.failure?.isHardFailure === false,
      "NO_MATCHING_EMAIL must never be isHardFailure"
    );
    assert(
      outcome.message.includes("No matching Lateral Excel email was found"),
      `diagnostic message should be preserved for logs, got: ${outcome.message}`
    );
    // Cron route logic (src/app/api/cron/lateral/route.ts:107,123) is a
    // direct pass-through of outcome.status — this is the exact boolean it
    // computes before mapping to an HTTP status.
    const cronWouldReturn200 = outcome.status === "success";
    assert(cronWouldReturn200, "cron route would not return 200 for this outcome");

    const config = await readLateralSchedulerConfig();
    assert(
      config.lastRunSummary?.result === "success",
      `lastRunSummary.result should be success, got ${config.lastRunSummary?.result}`
    );
    assert(
      config.lastRunSummary?.adhocDsDateLabel === "No new Lateral demand sheet on last run",
      `lastRunSummary.adhocDsDateLabel mismatch, got: ${config.lastRunSummary?.adhocDsDateLabel}`
    );
    assert(
      config.lastRunSummary?.noNewSource === true,
      "lastRunSummary.noNewSource should be true"
    );
    assert(
      config.lastRunSummary?.failureReason === null,
      `lastRunSummary.failureReason should be null, got: ${config.lastRunSummary?.failureReason}`
    );

    const history = await listLateralSyncHistory(1);
    assert(history[0]?.result === "Success", `sync history result should be Success, got ${history[0]?.result}`);
    assert(history[0]?.error === null, `sync history error should be null, got ${history[0]?.error}`);

    const notifAfter = await notificationCount();
    assert(
      notifAfter === notifBefore,
      `no bell notification should fire for NO_MATCHING_EMAIL (before=${notifBefore}, after=${notifAfter})`
    );

    const checkpointAfterScenario = await readLateralGmailCheckpoint();
    assert(
      checkpointAfterScenario.attachmentFilename === checkpointBeforeAll.attachmentFilename &&
        checkpointAfterScenario.receivedAt === checkpointBeforeAll.receivedAt &&
        checkpointAfterScenario.processedAt === checkpointBeforeAll.processedAt,
      "gmail_checkpoint must be left untouched by a no-new-email run"
    );

    console.log("Scenario 1 OK: Success, no notification, checkpoint untouched.\n");
  }

  // --- Scenario 2: ALL_CANDIDATES_EXHAUSTED -> stays Failed, DOES notify ---
  {
    console.log("--- Scenario 2: ALL_CANDIDATES_EXHAUSTED ---");
    const notifBefore = await notificationCount();

    const deps: LateralJobDeps = {
      runSync: async () => ({
        ...baseSyncResult(),
        matchedAttachments: 1,
        skippedCandidates: [
          {
            messageId: "relb-decoy-msg",
            attachmentId: "relb-decoy-att",
            attachmentName: "Decoy.xlsx",
            receivedAt: "2026-10-09T03:00:00.000Z",
            receivedAtMs: Date.parse("2026-10-09T03:00:00.000Z"),
            status: "source_sheet_missing",
            error: 'The "ATCI DS" worksheet was not found in the source workbook.',
          },
        ],
        items: [
          {
            messageId: "relb-decoy-msg",
            attachmentId: "relb-decoy-att",
            attachmentName: "Decoy.xlsx",
            receivedAt: "2026-10-09T03:00:00.000Z",
            receivedAtMs: Date.parse("2026-10-09T03:00:00.000Z"),
            status: "source_sheet_missing",
            error: 'The "ATCI DS" worksheet was not found in the source workbook.',
          },
        ],
        message: "1 candidate found after checkpoint; 0 uploaded.",
      }),
    };

    const { outcome } = await invokeLateralJob("manual", deps);

    assert(outcome.status === "failed", `expected status failed, got ${outcome.status}`);
    assert(
      outcome.failure?.code === "ALL_CANDIDATES_EXHAUSTED",
      `expected ALL_CANDIDATES_EXHAUSTED, got ${outcome.failure?.code}`
    );
    assert(
      outcome.failure?.isHardFailure === true,
      "ALL_CANDIDATES_EXHAUSTED must be isHardFailure"
    );
    const cronWouldReturn500 = outcome.status !== "success";
    assert(cronWouldReturn500, "cron route would not return 500 for this outcome");

    const history = await listLateralSyncHistory(1);
    assert(history[0]?.result === "Failed", `sync history result should be Failed, got ${history[0]?.result}`);

    const notifAfter = await notificationCount();
    assert(
      notifAfter === notifBefore + 1,
      `ALL_CANDIDATES_EXHAUSTED must send exactly one bell notification (before=${notifBefore}, after=${notifAfter})`
    );
    const notifications = await listAppNotifications(1);
    assert(
      notifications[0]?.kind === "dataset_sync_failed",
      `expected dataset_sync_failed notification kind, got ${notifications[0]?.kind}`
    );

    console.log("Scenario 2 OK: Failed, notification sent.\n");
  }

  // --- Scenario 3: a real hard failure (simulated Drive upload failure) ---
  {
    console.log("--- Scenario 3: real hard failure (hardStopped) ---");

    const deps: LateralJobDeps = {
      runSync: async () => ({
        ...baseSyncResult(),
        hardStopped: true,
        stoppedOnFailure: true,
        matchedAttachments: 1,
        items: [
          {
            messageId: "relb-real-msg",
            attachmentId: "relb-real-att",
            attachmentName: "ATCI_Lateral_DS_09Oct2026.xlsx",
            receivedAt: "2026-10-09T04:00:00.000Z",
            receivedAtMs: Date.parse("2026-10-09T04:00:00.000Z"),
            status: "upload_failed",
            error: "Uploading the Excel file to Google Drive failed (simulated).",
          },
        ],
        message: "Upload failed.",
      }),
    };

    const { outcome } = await invokeLateralJob("manual", deps);

    assert(outcome.status === "failed", `expected status failed, got ${outcome.status}`);
    assert(
      outcome.failure?.code === "GOOGLE_DRIVE_UPLOAD_FAILURE",
      `expected GOOGLE_DRIVE_UPLOAD_FAILURE, got ${outcome.failure?.code}`
    );
    assert(outcome.failure?.isHardFailure === true, "a real hard failure must be isHardFailure");

    console.log("Scenario 3 OK: Failed.\n");
  }

  // --- Scenario 4: NO_MATCHING_EMAIL with processingSetup UNCONFIGURED ---
  {
    console.log("--- Scenario 4: NO_MATCHING_EMAIL + processingSetup not configured ---");
    await clearLateralDataProcessingSetup();

    const deps: LateralJobDeps = {
      runSync: async () => baseSyncResult(),
    };
    const { outcome } = await invokeLateralJob("manual", deps);

    assert(
      outcome.status === "success",
      `expected success even with no processingSetup, got ${outcome.status}`
    );
    assert(
      outcome.failure?.code === "NO_MATCHING_EMAIL",
      `expected NO_MATCHING_EMAIL, got ${outcome.failure?.code}`
    );

    // Restore setup so a human re-running this script by hand doesn't leave
    // the throwaway DB's Lateral config cleared for any later manual poking.
    await writeLateralDataProcessingSetup({
      ...createEmptyLateralDataProcessingSetup(),
      updatedAt: new Date().toISOString(),
    });

    console.log("Scenario 4 OK: Success even with Lateral Dataset Setup unconfigured.\n");
  }

  console.log("verify-lateral-no-new-email-success: ALL SCENARIOS OK");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });
