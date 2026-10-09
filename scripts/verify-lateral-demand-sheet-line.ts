/**
 * Live smoke test for Release B Stage 2 — the "Latest demand sheet" line's
 * data source (gmail_checkpoint) against a real (throwaway) Postgres.
 *
 * Proves, for BOTH Lateral (account 'default') and Executive (account
 * 'executive'):
 *  1. Seeding a real checkpoint advance (simulating a prior real run)
 *     populates attachment_file / received_at / processed_at.
 *  2. Running a no-new-email tick (via each job's existing deps injection
 *     seam — Lateral's new one, Executive's pre-existing
 *     InvokeExecutiveJobDeps) leaves that row byte-for-byte unchanged —
 *     the line's source data survives an idle tick.
 *
 * Requires ARA_PERSISTENCE=postgres and POSTGRES_URL pointing at a
 * THROWAWAY database. Refuses to run otherwise.
 *
 * Run: npm run test:lateral-demand-sheet-line
 */
import postgres from "postgres";
import {
  advanceLateralGmailCheckpoint,
  readLateralGmailCheckpoint,
} from "../src/services/lateral-processing/lateral-gmail-checkpoint-store";
import {
  invokeLateralJob,
} from "../src/services/lateral-processing/lateral-scheduler";
import type { LateralJobDeps } from "../src/services/lateral-processing/lateral-job";
import type { LateralIncrementalSyncResult } from "../src/services/lateral-processing/lateral-gmail-incremental-sync";
import {
  writeLateralDataProcessingSetup,
} from "../src/services/lateral-processing/setup-store";
import { createEmptyLateralDataProcessingSetup } from "../src/types/lateral-processing-setup";

import {
  advanceExecutiveGmailCheckpoint,
  readExecutiveGmailCheckpoint,
} from "../src/services/executive-processing/executive-gmail-checkpoint-store";
import {
  invokeExecutiveJob,
  type InvokeExecutiveJobDeps,
} from "../src/services/executive-processing/executive-job";
import type { ExecutiveIncrementalSyncResult } from "../src/services/executive-processing/executive-gmail-incremental-sync";

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

async function main() {
  console.log("=== Release B Stage 2 — demand-sheet line source data (live, throwaway Postgres) ===\n");

  await writeLateralDataProcessingSetup({
    ...createEmptyLateralDataProcessingSetup(),
    updatedAt: new Date().toISOString(),
  });

  // --- Lateral ---
  {
    console.log("--- Lateral gmail_checkpoint ---");
    const seeded = await advanceLateralGmailCheckpoint({
      messageId: "relb-line-lateral-msg",
      attachmentId: "relb-line-lateral-att",
      receivedAt: "2026-10-07T04:30:00.000Z",
      receivedAtMs: Date.parse("2026-10-07T04:30:00.000Z"),
      attachmentFilename: "ATCI_Lateral_DS_07Oct2026.xlsx",
      attachmentSize: 12345,
      driveFileId: "relb-line-lateral-drive-id",
      processedAt: "2026-10-07T04:35:12.000Z",
      processingResult: "SUCCESS",
    });
    assert(seeded.attachmentFilename === "ATCI_Lateral_DS_07Oct2026.xlsx", "seed did not stick");

    const deps: LateralJobDeps = {
      runSync: async (): Promise<LateralIncrementalSyncResult> => ({
        checkpointBefore: seeded,
        checkpointAfter: seeded,
        query: "relb-fake-query",
        gmailKeywords: ["lateral"],
        syncPurpose: "full_pipeline",
        scannedMessages: 2,
        matchedAttachments: 0,
        processedCount: 0,
        uploadedCount: 0,
        failedCount: 0,
        stoppedOnFailure: false,
        hardStopped: false,
        skippedCandidates: [],
        items: [],
        warnings: [],
        message: "Scanned 2 message(s). No candidate attachments matched.",
        pendingCheckpointAdvances: [],
        lastSourceRead: null,
        lastMasterDiscovery: null,
      }),
    };

    const { outcome } = await invokeLateralJob("manual", deps);
    assert(outcome.status === "success", `expected success, got ${outcome.status}`);

    const after = await readLateralGmailCheckpoint();
    assert(
      after.attachmentFilename === "ATCI_Lateral_DS_07Oct2026.xlsx" &&
        after.receivedAt === "2026-10-07T04:30:00.000Z" &&
        after.processedAt === "2026-10-07T04:35:12.000Z" &&
        after.driveFileId === "relb-line-lateral-drive-id",
      "Lateral gmail_checkpoint must be unchanged by a no-new-email tick"
    );
    console.log(
      "OK — Lateral line data survives idle tick: file=%s received=%s processed=%s",
      after.attachmentFilename,
      after.receivedAt,
      after.processedAt
    );
  }

  // --- Executive ---
  {
    console.log("\n--- Executive gmail_checkpoint ---");
    const seeded = await advanceExecutiveGmailCheckpoint({
      messageId: "relb-line-executive-msg",
      attachmentId: "relb-line-executive-att",
      receivedAt: "2026-10-08T05:00:00.000Z",
      receivedAtMs: Date.parse("2026-10-08T05:00:00.000Z"),
      attachmentFilename: "ATCI Exec DS_08Oct2026.xlsx",
      driveFileId: "relb-line-executive-drive-id",
      processedAt: "2026-10-08T05:04:45.000Z",
      processingResult: "SUCCESS",
    });
    assert(seeded.attachmentFilename === "ATCI Exec DS_08Oct2026.xlsx", "seed did not stick");

    const deps: InvokeExecutiveJobDeps = {
      runSync: async (): Promise<ExecutiveIncrementalSyncResult> => ({
        checkpointBefore: seeded,
        checkpointAfter: seeded,
        query: "relb-fake-query",
        gmailKeywords: ["executive"],
        scannedMessages: 2,
        matchedAttachments: 0,
        processedCount: 0,
        uploadedCount: 0,
        failedCount: 0,
        stoppedOnFailure: false,
        items: [],
        warnings: [],
        message: "Scanned 2 message(s). No candidate attachments matched.",
        pendingCheckpointAdvances: [],
      }),
    };

    const outcome = await invokeExecutiveJob("manual", deps);
    assert(outcome.status === "success", `expected success, got ${outcome.status}`);

    const after = await readExecutiveGmailCheckpoint();
    assert(
      after.attachmentFilename === "ATCI Exec DS_08Oct2026.xlsx" &&
        after.receivedAt === "2026-10-08T05:00:00.000Z" &&
        after.processedAt === "2026-10-08T05:04:45.000Z" &&
        after.driveFileId === "relb-line-executive-drive-id",
      "Executive gmail_checkpoint must be unchanged by a no-new-email tick"
    );
    console.log(
      "OK — Executive line data survives idle tick: file=%s received=%s processed=%s",
      after.attachmentFilename,
      after.receivedAt,
      after.processedAt
    );
  }

  console.log("\nverify-lateral-demand-sheet-line: ALL SCENARIOS OK");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });
