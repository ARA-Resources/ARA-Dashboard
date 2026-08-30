/**
 * Phase 3A — Gmail/Drive acquisition → ATCI DS → lateral_staging.
 *
 * Boundary:
 *  - Gmail/Drive layer acquires workbook (reuses existing sync)
 *  - Staging importer receives a local workbook path only
 *  - Checkpoint advances ONLY after staging import SUCCESS
 *
 * Does NOT: touch lateral_master, Job Status, Posted, P-Roles,
 * Dashboard, Run All, or the full Master Excel pipeline.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type postgres from "postgres";
import {
  advanceLateralGmailCheckpoint,
  readLateralGmailCheckpoint,
} from "@/services/lateral-processing/lateral-gmail-checkpoint-store";
import {
  runLateralGmailIncrementalSync,
  type LateralIncrementalSyncResult,
  type LateralPendingCheckpointAdvance,
} from "@/services/lateral-processing/lateral-gmail-incremental-sync";
import {
  importAtciDsWorkbookToStaging,
  type LateralStagingImportReport,
} from "@/services/lateral-processing/lateral-staging-import";
import {
  formatLateralPgDateDdMmYyyy,
  formatLateralPgTimestampIst,
} from "@/services/lateral-processing/lateral-master-pg-backfill";
import type { LateralGmailCheckpoint } from "@/types/lateral-gmail-checkpoint";

export type LateralGmailStagingFailureStage =
  | "gmail_search"
  | "no_matching_email"
  | "attachment_not_found"
  | "invalid_attachment"
  | "workbook_read"
  | "atci_ds_missing"
  | "column_mapping"
  | "duplicate_jr"
  | "validation"
  | "staging_database"
  | "checkpoint"
  | "unknown";

export interface LateralGmailStagingJobReport {
  status: "success" | "idle" | "failed";
  message: string;
  failureStage: LateralGmailStagingFailureStage | null;
  ranAtDisplay: string;
  processingDateDisplay: string | null;
  gmailKeywords: string[];
  gmailQuery: string | null;
  email: {
    messageId: string | null;
    subject: string | null;
    sender: string | null;
    receivedAt: string | null;
  };
  attachmentFilename: string | null;
  worksheet: string | null;
  stagingImport: LateralStagingImportReport | null;
  checkpoint: {
    before: LateralGmailCheckpoint;
    after: LateralGmailCheckpoint;
    advanced: boolean;
    reason: string;
  };
  sync: {
    scannedMessages: number;
    matchedAttachments: number;
    uploadedCount: number;
    failedCount: number;
    stoppedOnFailure: boolean;
    syncMessage: string;
  } | null;
}

export interface LateralGmailStagingJobDeps {
  acquire?: () => Promise<LateralIncrementalSyncResult>;
  importWorkbook?: typeof importAtciDsWorkbookToStaging;
  advanceCheckpoint?: typeof advanceLateralGmailCheckpoint;
  readCheckpoint?: typeof readLateralGmailCheckpoint;
}

function classifyStagingFailure(
  report: LateralStagingImportReport
): LateralGmailStagingFailureStage {
  const msg = report.message.toLowerCase();
  if (/atci ds/i.test(report.message) && /not found|missing/i.test(msg)) {
    return "atci_ds_missing";
  }
  if (/mapping|ambiguous|could not map/i.test(msg)) return "column_mapping";
  if (/duplicate/i.test(msg)) return "duplicate_jr";
  if (/validation/i.test(msg)) return "validation";
  if (/insert|truncate|postgres|database|sql/i.test(msg)) {
    return "staging_database";
  }
  if (/read|open|workbook/i.test(msg)) return "workbook_read";
  return "validation";
}

function classifySyncFailure(
  sync: LateralIncrementalSyncResult
): LateralGmailStagingFailureStage {
  const failed = sync.items.find((i) => i.status !== "uploaded_drive");
  if (!failed) return "gmail_search";
  switch (failed.status) {
    case "validation_failed":
      return "invalid_attachment";
    case "source_sheet_missing":
      return "atci_ds_missing";
    case "source_read_failed":
      return "workbook_read";
    case "download_failed":
      return "attachment_not_found";
    case "upload_failed":
      return "gmail_search";
    default:
      return "gmail_search";
  }
}

async function appendLog(entry: Record<string, unknown>) {
  console.info("[lateral-gmail-staging]", JSON.stringify(entry));
}

/**
 * Acquire Adhoc DS via existing Gmail/Drive path, then import ATCI DS → staging.
 * Advances Gmail checkpoint only after a successful staging replace.
 */
export async function executeLateralGmailStagingJob(options: {
  sql: ReturnType<typeof postgres>;
  dryRun?: boolean;
  /**
   * When multiple emails are pending after the checkpoint, only import the
   * newest (last chronological). Checkpoint advances to that message on success.
   * Useful for catch-up / live proof without replaying every intermediate day.
   */
  latestOnly?: boolean;
  deps?: LateralGmailStagingJobDeps;
}): Promise<LateralGmailStagingJobReport> {
  const ranAt = new Date();
  const ranAtDisplay = formatLateralPgTimestampIst(ranAt);
  const dryRun = Boolean(options.dryRun);
  const readCheckpoint =
    options.deps?.readCheckpoint ?? readLateralGmailCheckpoint;
  const advanceCheckpoint =
    options.deps?.advanceCheckpoint ?? advanceLateralGmailCheckpoint;
  const importWorkbook =
    options.deps?.importWorkbook ?? importAtciDsWorkbookToStaging;
  const acquire =
    options.deps?.acquire ??
    (() =>
      runLateralGmailIncrementalSync({
        purpose: "staging_only",
        ...(options.latestOnly
          ? { maxUploads: 1, processNewestFirst: true }
          : {}),
      }));

  const checkpointBefore = await readCheckpoint();

  let sync: LateralIncrementalSyncResult;
  try {
    sync = await acquire();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Gmail search / acquisition failed.";
    await appendLog({
      event: "lateral_gmail_staging_acquire_failed",
      error: message,
    });
    const after = await readCheckpoint();
    return {
      status: "failed",
      message: `Gmail search failure: ${message}`,
      failureStage: "gmail_search",
      ranAtDisplay,
      processingDateDisplay: null,
      gmailKeywords: [],
      gmailQuery: null,
      email: {
        messageId: null,
        subject: null,
        sender: null,
        receivedAt: null,
      },
      attachmentFilename: null,
      worksheet: null,
      stagingImport: null,
      checkpoint: {
        before: checkpointBefore,
        after,
        advanced: false,
        reason: "Gmail acquisition failed — checkpoint not advanced.",
      },
      sync: null,
    };
  }

  const baseSync = {
    scannedMessages: sync.scannedMessages,
    matchedAttachments: sync.matchedAttachments,
    uploadedCount: sync.uploadedCount,
    failedCount: sync.failedCount,
    stoppedOnFailure: sync.stoppedOnFailure,
    syncMessage: sync.message,
  };

  if (sync.stoppedOnFailure || sync.failedCount > 0) {
    const after = await readCheckpoint();
    const stage = classifySyncFailure(sync);
    return {
      status: "failed",
      message: sync.message,
      failureStage: stage,
      ranAtDisplay,
      processingDateDisplay: null,
      gmailKeywords: sync.gmailKeywords,
      gmailQuery: sync.query,
      email: {
        messageId: sync.items[0]?.messageId ?? null,
        subject: sync.items[0]?.subject ?? null,
        sender: sync.items[0]?.sender ?? null,
        receivedAt: sync.items[0]?.receivedAt ?? null,
      },
      attachmentFilename: sync.items[0]?.attachmentName ?? null,
      worksheet: sync.lastSourceRead?.worksheetName ?? null,
      stagingImport: null,
      checkpoint: {
        before: checkpointBefore,
        after,
        advanced: false,
        reason:
          "Gmail/Drive acquisition failed before staging — checkpoint not advanced.",
      },
      sync: baseSync,
    };
  }

  if (sync.pendingCheckpointAdvances.length === 0) {
    const after = await readCheckpoint();
    return {
      status: "idle",
      message:
        sync.message ||
        "No new Lateral Adhoc DS email after checkpoint. Staging unchanged.",
      failureStage: null,
      ranAtDisplay,
      processingDateDisplay: null,
      gmailKeywords: sync.gmailKeywords,
      gmailQuery: sync.query,
      email: {
        messageId: null,
        subject: null,
        sender: null,
        receivedAt: null,
      },
      attachmentFilename: null,
      worksheet: null,
      stagingImport: null,
      checkpoint: {
        before: checkpointBefore,
        after,
        advanced: false,
        reason: "No new matching email — checkpoint unchanged.",
      },
      sync: baseSync,
    };
  }

  let lastImport: LateralStagingImportReport | null = null;
  let lastPending: LateralPendingCheckpointAdvance | null = null;
  let checkpointAdvanced = false;
  let checkpointAfter = checkpointBefore;
  let failureStage: LateralGmailStagingFailureStage | null = null;
  let failureMessage: string | null = null;

  const pendingQueue = options.latestOnly
    ? sync.pendingCheckpointAdvances.slice(-1)
    : sync.pendingCheckpointAdvances;

  if (
    options.latestOnly &&
    sync.pendingCheckpointAdvances.length > pendingQueue.length
  ) {
    await appendLog({
      event: "lateral_gmail_staging_latest_only",
      pendingTotal: sync.pendingCheckpointAdvances.length,
      selectedMessageId: pendingQueue[0]?.messageId ?? null,
      selectedAttachment: pendingQueue[0]?.attachmentFilename ?? null,
    });
  }

  for (const pending of pendingQueue) {
    lastPending = pending;
    const workbookPath = pending.localWorkbookPath?.trim();
    if (!workbookPath) {
      failureStage = "attachment_not_found";
      failureMessage =
        "Gmail acquisition succeeded but local workbook path is missing — cannot import staging.";
      break;
    }

    try {
      await fs.access(workbookPath);
    } catch {
      failureStage = "attachment_not_found";
      failureMessage = `Downloaded workbook not found at ${workbookPath}`;
      break;
    }

    await appendLog({
      event: "lateral_gmail_staging_import_start",
      messageId: pending.messageId,
      attachmentFilename: pending.attachmentFilename,
      workbookPath: path.basename(workbookPath),
      dryRun,
    });

    let importReport: LateralStagingImportReport;
    try {
      importReport = await importWorkbook({
        sql: options.sql,
        workbookPath,
        dryRun,
      });
    } catch (err) {
      failureStage = "staging_database";
      failureMessage =
        err instanceof Error
          ? err.message
          : "Staging database / import threw unexpectedly.";
      await appendLog({
        event: "lateral_gmail_staging_import_threw",
        messageId: pending.messageId,
        error: failureMessage,
        checkpointAdvanced: false,
      });
      break;
    }
    lastImport = importReport;

    if (importReport.status !== "success") {
      failureStage = classifyStagingFailure(importReport);
      failureMessage = importReport.message;
      await appendLog({
        event: "lateral_gmail_staging_import_failed",
        messageId: pending.messageId,
        failureStage,
        error: failureMessage,
        checkpointAdvanced: false,
      });
      break;
    }

    if (dryRun) {
      await appendLog({
        event: "lateral_gmail_staging_dry_run_skip_checkpoint",
        messageId: pending.messageId,
      });
      continue;
    }

    try {
      checkpointAfter = await advanceCheckpoint({
        messageId: pending.messageId,
        attachmentId: pending.attachmentId,
        receivedAt: pending.receivedAt,
        receivedAtMs: pending.receivedAtMs,
        attachmentFilename: pending.attachmentFilename,
        driveFileId: pending.driveFileId,
        processingResult: "SUCCESS",
      });
      checkpointAdvanced = true;
      await appendLog({
        event: "lateral_gmail_staging_checkpoint_advanced",
        messageId: pending.messageId,
        attachmentFilename: pending.attachmentFilename,
        driveFileId: pending.driveFileId,
        processedAt: checkpointAfter.processedAt,
      });
    } catch (err) {
      failureStage = "checkpoint";
      failureMessage =
        err instanceof Error
          ? `Staging import succeeded but checkpoint advance failed: ${err.message}`
          : "Staging import succeeded but checkpoint advance failed.";
      break;
    }
  }

  if (failureMessage) {
    const after = await readCheckpoint();
    return {
      status: "failed",
      message: failureMessage,
      failureStage: failureStage ?? "unknown",
      ranAtDisplay,
      processingDateDisplay: lastImport?.processingDateDisplay ?? null,
      gmailKeywords: sync.gmailKeywords,
      gmailQuery: sync.query,
      email: {
        messageId: lastPending?.messageId ?? null,
        subject: lastPending?.subject ?? null,
        sender: lastPending?.sender ?? null,
        receivedAt: lastPending?.receivedAt ?? null,
      },
      attachmentFilename: lastPending?.attachmentFilename ?? null,
      worksheet: lastImport?.source.worksheetName ?? null,
      stagingImport: lastImport,
      checkpoint: {
        before: checkpointBefore,
        after: checkpointAdvanced ? after : checkpointBefore,
        advanced: checkpointAdvanced,
        reason: checkpointAdvanced
          ? "Earlier email(s) advanced; failed on a later workbook — see message."
          : "Staging import / validation failed — checkpoint NOT advanced for the failed message.",
      },
      sync: baseSync,
    };
  }

  const after = await readCheckpoint();
  return {
    status: "success",
    message: dryRun
      ? `Dry run: validated ${sync.pendingCheckpointAdvances.length} Gmail workbook(s); staging and checkpoint unchanged.`
      : `Gmail → ATCI DS → lateral_staging succeeded (${lastImport?.rows.validRows ?? 0} rows).`,
    failureStage: null,
    ranAtDisplay,
    processingDateDisplay:
      lastImport?.processingDateDisplay ??
      formatLateralPgDateDdMmYyyy(
        `${ranAt.getFullYear()}-${String(ranAt.getMonth() + 1).padStart(2, "0")}-${String(ranAt.getDate()).padStart(2, "0")}`
      ),
    gmailKeywords: sync.gmailKeywords,
    gmailQuery: sync.query,
    email: {
      messageId: lastPending?.messageId ?? null,
      subject: lastPending?.subject ?? null,
      sender: lastPending?.sender ?? null,
      receivedAt: lastPending?.receivedAt ?? null,
    },
    attachmentFilename: lastPending?.attachmentFilename ?? null,
    worksheet: lastImport?.source.worksheetName ?? "ATCI DS",
    stagingImport: lastImport,
    checkpoint: {
      before: checkpointBefore,
      after: dryRun ? checkpointBefore : after,
      advanced: checkpointAdvanced,
      reason: dryRun
        ? "Dry run — checkpoint not advanced."
        : checkpointAdvanced
          ? "Advanced after successful staging import (existing SUCCESS semantics)."
          : "No checkpoint advance.",
    },
    sync: baseSync,
  };
}

export function printLateralGmailStagingJobReport(
  report: LateralGmailStagingJobReport
) {
  console.log("\n========== PHASE 3A — GMAIL → LATERAL_STAGING ==========");
  console.log(`Status: ${report.status}`);
  console.log(`Message: ${report.message}`);
  if (report.failureStage) console.log(`Failure stage: ${report.failureStage}`);
  console.log(`Ran at: ${report.ranAtDisplay}`);
  console.log(`Business / processing date: ${report.processingDateDisplay ?? "(n/a)"}`);
  console.log("\n-- Source (Gmail) --");
  console.log(
    `Keywords: ${report.gmailKeywords.length ? report.gmailKeywords.join(" | ") : "(none)"}`
  );
  console.log(`Query: ${report.gmailQuery ?? "(n/a)"}`);
  console.log(`Message ID: ${report.email.messageId ?? "(n/a)"}`);
  console.log(`Subject: ${report.email.subject ?? "(n/a)"}`);
  console.log(`Sender: ${report.email.sender ?? "(n/a)"}`);
  console.log(`Received: ${report.email.receivedAt ?? "(n/a)"}`);
  console.log(`Attachment: ${report.attachmentFilename ?? "(n/a)"}`);
  console.log(`Worksheet: ${report.worksheet ?? "(n/a)"}`);
  if (report.sync) {
    console.log(
      `Sync: scanned=${report.sync.scannedMessages} matched=${report.sync.matchedAttachments} uploaded=${report.sync.uploadedCount} failed=${report.sync.failedCount}`
    );
  }
  console.log("\n-- Checkpoint --");
  console.log(`Advanced: ${report.checkpoint.advanced}`);
  console.log(`Reason: ${report.checkpoint.reason}`);
  console.log(
    `Before messageId: ${report.checkpoint.before.messageId ?? "(none)"}`
  );
  console.log(
    `After messageId: ${report.checkpoint.after.messageId ?? "(none)"}`
  );
  if (report.stagingImport) {
    const s = report.stagingImport;
    console.log("\n-- Staging import --");
    console.log(`Status: ${s.status}`);
    console.log(`Source rows: ${s.rows.totalSourceRows}`);
    console.log(`Valid: ${s.rows.validRows}`);
    console.log(`Invalid: ${s.rows.invalidRows}`);
    console.log(`Duplicates: ${s.rows.duplicateJrCount}`);
    console.log(`Staging before: ${s.database.stagingCountBefore}`);
    console.log(`Staging after: ${s.database.stagingCountAfter}`);
    console.log(`Master before: ${s.database.masterCountBefore}`);
    console.log(`Master after: ${s.database.masterCountAfter}`);
    console.log(`Master unchanged: ${s.database.masterUnchanged}`);
  }
  console.log("========================================================\n");
}
