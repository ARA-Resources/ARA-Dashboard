import fs from "node:fs/promises";
import path from "node:path";
import { pushAppNotification } from "@/services/dataset/notifications-store";
import { DATASET_LOG_DIR } from "@/services/dataset/paths";
import { advanceFinalLateralGmailCheckpoint } from "@/services/lateral-processing/lateral-final-checkpoint";
import {
  assertNeverReportSuccessOnFailure,
  classifyLateralFailure,
  createLateralStageFailure,
  evaluateLateralSyncQueueOutcome,
  formatLateralFailureForLog,
  type LateralStageFailure,
} from "@/services/lateral-processing/lateral-failure-handling";
import { runLateralGmailIncrementalSync } from "@/services/lateral-processing/lateral-gmail-incremental-sync";
import {
  finishLateralRunProgress,
  getLateralRunProgress,
  markLateralRunIdleAfterNoNewSource,
  startLateralRunProgress,
  updateLateralGmailProgress,
  updateLateralPipelineProgress,
} from "@/services/lateral-processing/lateral-run-progress";
import { runLateralDatasetPipeline } from "@/services/lateral-processing/pipeline";
import { readLateralDataProcessingSetup } from "@/services/lateral-processing/setup-store";
import type {
  LateralJobOutcome,
  LateralJobTrigger,
} from "@/types/lateral-scheduler";

async function logJobCompletedWithSkips(entry: {
  ranAt: string;
  trigger: LateralJobTrigger;
  skippedCandidates: Array<{ attachmentName: string; messageId: string; error: string }>;
  sourceFilename: string | null;
}): Promise<void> {
  const record = {
    event: "lateral_run_completed_with_skips",
    at: entry.ranAt,
    trigger: entry.trigger,
    sourceFilename: entry.sourceFilename,
    skippedCount: entry.skippedCandidates.length,
    skippedCandidates: entry.skippedCandidates,
  };
  console.info("[lateral-job] completed with skips", JSON.stringify(record));
  try {
    await fs.mkdir(DATASET_LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    await fs.appendFile(
      path.join(DATASET_LOG_DIR, `lateral-job-${day}.jsonl`),
      `${JSON.stringify(record)}\n`,
      "utf8"
    );
  } catch {
    // Non-fatal — logging must not mask the real outcome.
  }
}

async function logJobFailure(failure: LateralStageFailure): Promise<void> {
  const entry = formatLateralFailureForLog(failure);
  // Always emit to stdout — captured by the container's log driver.
  console.error("[lateral-job] failure", JSON.stringify(entry));
  // In file mode also write to disk for local audit trail.
  try {
    await fs.mkdir(DATASET_LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    await fs.appendFile(
      path.join(DATASET_LOG_DIR, `lateral-job-${day}.jsonl`),
      `${JSON.stringify(entry)}\n`,
      "utf8"
    );
  } catch {
    // Non-fatal — logging must not mask the real error.
  }
}

/**
 * Canonical Lateral Dataset job with robust failure handling.
 *
 * On ANY hard failure:
 *  - stop
 *  - do not continue later stages
 *  - do not advance Gmail checkpoint
 *  - preserve last successful Master Workbook
 *  - log exact failed stage
 *  - surface human-readable error
 *  - allow next scheduled run to retry
 *  - never report success
 */
export async function executeLateralDatasetJob(
  trigger: LateralJobTrigger
): Promise<LateralJobOutcome> {
  const ranAt = new Date().toISOString();
  const startedMs = Date.now();

  startLateralRunProgress(trigger);

  try {
    return await executeLateralDatasetJobBody(trigger, ranAt, startedMs);
  } finally {
    const progress = getLateralRunProgress();
    if (progress.active) {
      finishLateralRunProgress({ skippedRemaining: true });
    }
  }
}

async function executeLateralDatasetJobBody(
  trigger: LateralJobTrigger,
  ranAt: string,
  startedMs: number
): Promise<LateralJobOutcome> {

  let syncOk = false;
  let pipelineOk = false;
  let stoppedOnUploadOrSyncFailure = false;
  let checkpointAdvanced = false;
  let hardFailure: LateralStageFailure | null = null;
  const parts: string[] = [];

  let syncResult: Awaited<ReturnType<typeof runLateralGmailIncrementalSync>> | null =
    null;
  // The specific sync item this run actually attempted and failed on (if any) —
  // hoisted so the sync-history row below can prefer THIS run's real
  // messageId/sender/subject/attachmentName over the stale pre-run checkpoint.
  let failedItem:
    | NonNullable<
        Awaited<ReturnType<typeof runLateralGmailIncrementalSync>>
      >["items"][number]
    | undefined;
  let pipelineSummary: {
    rowsImported: number;
    newCount: number;
    activeCount: number;
    reopenCount: number;
    closedCount: number;
  } | null = null;

  updateLateralGmailProgress("gmail_search", "active");

  try {
    syncResult = await runLateralGmailIncrementalSync();
    // A recoverable candidate failure that was skipped-and-continued-past
    // does NOT make the sync phase a failure as long as something later in
    // the queue succeeded — only a genuine hard stop (non-recoverable) or
    // every candidate being exhausted with none succeeding does.
    const queueOutcome = evaluateLateralSyncQueueOutcome({
      uploadedCount: syncResult.uploadedCount,
      hardStopped: syncResult.hardStopped,
      skippedCandidateCount: syncResult.skippedCandidates.length,
    });
    const allCandidatesExhausted = queueOutcome.allCandidatesExhausted;
    syncOk = queueOutcome.syncOk;
    stoppedOnUploadOrSyncFailure = queueOutcome.stoppedOnUploadOrSyncFailure;
    parts.push(`Gmail/Drive: ${syncResult.message}`);

    if (syncResult.hardStopped) {
      // The hard-stop-causing item is always the last one pushed — every
      // recoverable failure before it was skipped-and-continued-past, not
      // pushed as the terminal item.
      failedItem = syncResult.items[syncResult.items.length - 1];

      const classified = classifyLateralFailure({
        error: failedItem?.error || syncResult.message,
        syncItemStatus: failedItem?.status,
      });
      hardFailure = createLateralStageFailure({
        code: classified.code,
        stage: classified.stage,
        detail: failedItem?.error || syncResult.message,
        messageOverride: failedItem?.error || syncResult.message,
      });
      updateLateralGmailProgress(
        "gmail_search",
        "failed",
        hardFailure.message
      );
      parts.push(
        `FAILED at ${hardFailure.failedStage}: ${hardFailure.message}`
      );
    } else if (allCandidatesExhausted) {
      const lastSkip =
        syncResult.skippedCandidates[syncResult.skippedCandidates.length - 1];
      hardFailure = createLateralStageFailure({
        code: "ALL_CANDIDATES_EXHAUSTED",
        stage: "gmail_email_match",
        detail: syncResult.skippedCandidates
          .map((c) => `"${c.attachmentName}": ${c.error}`)
          .join("; "),
        messageOverride: `All ${syncResult.skippedCandidates.length} candidate email(s) found after the checkpoint failed. Last: "${lastSkip?.attachmentName}" — ${lastSkip?.error}`,
      });
      updateLateralGmailProgress(
        "gmail_search",
        "failed",
        hardFailure.message
      );
      parts.push(
        `FAILED at ${hardFailure.failedStage}: ${hardFailure.message}`
      );
    } else if (
      syncResult.uploadedCount === 0 &&
      syncResult.skippedCandidates.length === 0 &&
      syncResult.matchedAttachments === 0
    ) {
      // Clear terminal state — not a hard failure; no Master work required for mail.
      const idle = createLateralStageFailure({
        code: "NO_MATCHING_EMAIL",
        stage: "gmail_email_match",
      });
      updateLateralGmailProgress("gmail_search", "ok");
      updateLateralGmailProgress("gmail_download", "skipped", idle.message);
      updateLateralGmailProgress("drive_upload", "skipped");
      updateLateralGmailProgress("drive_replace", "skipped");
      parts.push(idle.message);
    } else {
      updateLateralGmailProgress("gmail_search", "ok");
      updateLateralGmailProgress("gmail_download", "ok");
      if (syncResult.uploadedCount > 0) {
        updateLateralGmailProgress("drive_upload", "ok");
        updateLateralGmailProgress("drive_replace", "ok");
        if (syncResult.skippedCandidates.length > 0) {
          parts.push(
            `Skipped ${syncResult.skippedCandidates.length} candidate(s) before success: ${syncResult.skippedCandidates
              .map((c) => `"${c.attachmentName}" (${c.error})`)
              .join("; ")}.`
          );
        }
      } else {
        updateLateralGmailProgress("drive_upload", "skipped");
        updateLateralGmailProgress("drive_replace", "skipped");
      }
    }
  } catch (error) {
    stoppedOnUploadOrSyncFailure = true;
    const message =
      error instanceof Error
        ? error.message
        : "Lateral incremental Gmail sync failed.";
    const classified = classifyLateralFailure({ error: message });
    // Prefer auth classification for thrown OAuth errors
    hardFailure = createLateralStageFailure({
      code: /oauth|not connected|token|invalid_grant/i.test(message)
        ? "GMAIL_AUTHENTICATION_FAILURE"
        : classified.code,
      stage: /oauth|not connected|token|invalid_grant/i.test(message)
        ? "gmail_authentication"
        : classified.stage,
      detail: message,
      messageOverride: message,
    });
    updateLateralGmailProgress("gmail_search", "failed", message);
    parts.push(`FAILED at ${hardFailure.failedStage}: ${hardFailure.message}`);
  }

  const pendingCheckpointAdvances =
    syncResult?.pendingCheckpointAdvances ?? [];
  const processingSetup = await readLateralDataProcessingSetup();

  // Hard sync failure → STOP. No pipeline. No checkpoint.
  if (hardFailure?.isHardFailure) {
    await logJobFailure(hardFailure).catch(() => undefined);
    parts.push(
      "Stopped. Gmail checkpoint NOT advanced. Last successful Master Workbook preserved. Next run can retry."
    );
  } else if (!processingSetup) {
    if (pendingCheckpointAdvances.length > 0) {
      hardFailure = createLateralStageFailure({
        code: "UNKNOWN_FAILURE",
        stage: "job",
        messageOverride:
          "Lateral Dataset Setup is not configured. Cannot complete Master update; checkpoint NOT advanced.",
      });
      await logJobFailure(hardFailure).catch(() => undefined);
      parts.push(hardFailure.message);
    } else {
      parts.push("Pipeline skipped — Lateral Dataset Setup is not configured.");
    }
  } else if (pendingCheckpointAdvances.length === 0 && !stoppedOnUploadOrSyncFailure) {
    const noNewMessage =
      "No new Lateral dataset found. Master workbook was not modified.";
    markLateralRunIdleAfterNoNewSource(noNewMessage);
    parts.push(noNewMessage);
  } else if (!hardFailure?.isHardFailure && pendingCheckpointAdvances.length > 0) {
    updateLateralPipelineProgress(1, "active");
    try {
      const pipelineResult = await runLateralDatasetPipeline();
      pipelineOk = pipelineResult.ok;

      if (!pipelineResult.ok) {
        hardFailure = createLateralStageFailure({
          code: (pipelineResult.failureCode as LateralStageFailure["code"]) ||
            classifyLateralFailure({
              error: pipelineResult.reason,
              pipelineFailedStep: pipelineResult.failedStep,
            }).code,
          stage: "pipeline",
          detail: pipelineResult.reason,
          messageOverride: `Pipeline failed at ${pipelineResult.failedStepName}: ${pipelineResult.reason}`,
        });
        await logJobFailure(hardFailure).catch(() => undefined);
        parts.push(
          `FAILED at ${pipelineResult.failureStage || hardFailure.failedStage}: ${hardFailure.message}`
        );
        parts.push(
          "Stopped. Gmail checkpoint NOT advanced. Last successful Master Workbook preserved. Next run can retry."
        );
      } else {
        pipelineSummary = {
          rowsImported: pipelineResult.rowsImported,
          newCount: pipelineResult.newRequisitions,
          activeCount: pipelineResult.activeUnchanged,
          reopenCount: pipelineResult.reopenedRequisitions,
          closedCount: pipelineResult.closedRequisitions,
        };
        parts.push(
          `Pipeline: ${pipelineResult.message} (${pipelineResult.rowsImported} rows)`
        );
        if (pipelineResult.xlsmSecondaryWarning) {
          parts.push(
            `WARNING (XLSM secondary): ${pipelineResult.xlsmSecondaryWarning}`
          );
        }

        const last =
          pendingCheckpointAdvances[pendingCheckpointAdvances.length - 1];
        const finalAdvance = await advanceFinalLateralGmailCheckpoint({
          pending: last,
          gmailSyncOk: syncOk,
          atciDsFound: Boolean(syncResult?.lastSourceRead?.worksheetName),
          masterWorkbookFound: Boolean(syncResult?.lastMasterDiscovery?.fileId),
          pipeline: pipelineResult,
        });

        if (!finalAdvance.ok) {
          hardFailure = createLateralStageFailure({
            code: "STATUS_RECONCILIATION_FAILURE",
            stage: "status_reconciliation",
            detail: finalAdvance.error,
            messageOverride: finalAdvance.error,
          });
          // Prefer final-update classification if gates mention drive/xlsm
          if (/xlsm|drive|save/i.test(finalAdvance.error)) {
            hardFailure = createLateralStageFailure({
              code: "GOOGLE_DRIVE_FINAL_UPDATE_FAILURE",
              stage: "drive_final_update",
              detail: finalAdvance.error,
              messageOverride: finalAdvance.error,
            });
          }
          pipelineOk = false;
          await logJobFailure(hardFailure).catch(() => undefined);
          parts.push(
            `FAILED at ${hardFailure.failedStage}: ${hardFailure.message}. Checkpoint NOT advanced. Next run can retry.`
          );
        } else {
          checkpointAdvanced = true;
          const cp = finalAdvance.checkpoint;
          parts.push(
            `FINAL checkpoint SUCCESS: messageId=${cp.messageId}; receivedAt=${cp.receivedAt}; attachment=${cp.attachmentFilename}; driveFileId=${cp.driveFileId}; processedAt=${cp.processedAt}; result=${cp.processingResult}`
          );
        }
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Lateral Dataset Processing Pipeline failed.";
      const classified = classifyLateralFailure({ error: message });
      hardFailure = createLateralStageFailure({
        code: classified.code,
        stage: classified.stage,
        detail: message,
        messageOverride: message,
      });
      await logJobFailure(hardFailure).catch(() => undefined);
      parts.push(
        `FAILED at ${hardFailure.failedStage}: ${hardFailure.message}. Checkpoint NOT advanced. Next run can retry.`
      );
    }
  }

  const durationMs = Math.max(0, Date.now() - startedMs);

  // Never report success when any hard stage failed.
  let effectiveStatus: LateralJobOutcome["status"];
  if (hardFailure?.isHardFailure) {
    effectiveStatus = "failed";
    pipelineOk = false;
    checkpointAdvanced = false;
  } else if (pendingCheckpointAdvances.length > 0) {
    effectiveStatus = checkpointAdvanced ? "success" : "failed";
  } else if (!processingSetup) {
    effectiveStatus = syncOk ? "partial" : "failed";
  } else if (syncOk && pipelineOk) {
    effectiveStatus = "success";
  } else if (syncOk || pipelineOk) {
    effectiveStatus = "partial";
  } else {
    effectiveStatus = "failed";
  }

  const successGuard = assertNeverReportSuccessOnFailure({
    hardFailure,
    checkpointAdvanced,
    claimedSuccess: effectiveStatus === "success",
  });
  if (!successGuard.ok) {
    effectiveStatus = "failed";
    checkpointAdvanced = false;
    if (!hardFailure) {
      hardFailure = createLateralStageFailure({
        code: "UNKNOWN_FAILURE",
        stage: "job",
        messageOverride: successGuard.reason,
      });
    }
    parts.push(successGuard.reason || "Success suppressed due to failure rules.");
  }

  const message = parts.join(" · ");

  const skippedCandidates = (syncResult?.skippedCandidates ?? []).map((c) => ({
    attachmentName: c.attachmentName,
    messageId: c.messageId,
    receivedAt: c.receivedAt,
    status: c.status,
    error: c.error,
  }));

  const pending = pendingCheckpointAdvances[pendingCheckpointAdvances.length - 1];
  const lastUploaded = syncResult?.items
    ?.slice()
    .reverse()
    .find((i) => i.status === "uploaded_drive" || i.driveFileId);

  // failedItem (this run's actual attempted-and-failed email, when there is
  // one) takes priority over pending/lastUploaded/checkpoint fallbacks —
  // otherwise a validation/download/etc. failure on a genuinely NEW email
  // would misreport the PREVIOUS run's already-succeeded email/file instead
  // of the one that actually failed just now.
  const sourceReceivedAt =
    failedItem?.receivedAt ||
    pending?.receivedAt ||
    lastUploaded?.receivedAt ||
    syncResult?.checkpointBefore.receivedAt ||
    null;
  const sourceFilename =
    failedItem?.attachmentName ||
    pending?.attachmentFilename ||
    lastUploaded?.attachmentName ||
    syncResult?.checkpointBefore.attachmentFilename ||
    null;
  const adhocDsDateLabel = (() => {
    if (pendingCheckpointAdvances.length === 0 && !hardFailure?.isHardFailure) {
      return "No new Adhoc DS on last run";
    }
    if (!sourceReceivedAt) {
      return sourceFilename
        ? `Source file: ${sourceFilename}`
        : "Adhoc DS date: (unknown)";
    }
    try {
      const d = new Date(sourceReceivedAt);
      if (Number.isNaN(d.getTime())) return `Adhoc DS date: ${sourceReceivedAt}`;
      const partsFmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).formatToParts(d);
      const day = partsFmt.find((p) => p.type === "day")?.value;
      const month = partsFmt.find((p) => p.type === "month")?.value;
      const year = partsFmt.find((p) => p.type === "year")?.value;
      if (day && month && year) return `Adhoc DS date: ${day}-${month}-${year}`;
    } catch {
      // fall through
    }
    return `Adhoc DS date: ${sourceReceivedAt}`;
  })();

  const countsLine = pipelineSummary
    ? `Rows ${pipelineSummary.rowsImported}; New ${pipelineSummary.newCount}; Reopen ${pipelineSummary.reopenCount}; Closed ${pipelineSummary.closedCount}; Active ${pipelineSummary.activeCount}`
    : null;

  const successHref = "/company/accenture/lateral/master-sheet";
  const failureHref = "/dataset/lateral";

  // A clean success with a skip behind it still deserves the "not entirely
  // unremarkable" notification kind — never let it look identical to a run
  // where nothing at all went wrong.
  const successWithSkips = effectiveStatus === "success" && skippedCandidates.length > 0;

  const notificationTitle =
    effectiveStatus === "failed"
      ? `Lateral Run All failed${hardFailure?.failedStage ? `: ${hardFailure.failedStage}` : ""}`
      : effectiveStatus === "partial"
        ? "Lateral Run All completed with warnings"
        : pendingCheckpointAdvances.length === 0
          ? "Lateral Run All: no new Adhoc DS"
          : successWithSkips
            ? `Lateral Run All succeeded (skipped ${skippedCandidates.length} candidate(s))`
            : "Lateral Run All succeeded";

  const skippedSummaryLine =
    skippedCandidates.length > 0
      ? `Skipped: ${skippedCandidates
          .map((c) => `"${c.attachmentName}" (${c.error})`)
          .join("; ")}`
      : null;

  const notificationBodyParts = [
    `Trigger: ${trigger}`,
    sourceFilename ? `Source: ${sourceFilename}` : null,
    adhocDsDateLabel,
    countsLine,
    hardFailure?.isHardFailure
      ? hardFailure.message
      : effectiveStatus === "success" && pendingCheckpointAdvances.length === 0
        ? "No new Lateral dataset found. Master was not modified."
        : effectiveStatus === "success"
          ? "Job Status + Posted updated in PostgreSQL lateral_master."
          : message,
    skippedSummaryLine,
  ].filter(Boolean);

  await pushAppNotification({
    kind:
      effectiveStatus === "failed"
        ? "dataset_sync_failed"
        : effectiveStatus === "partial" || successWithSkips
          ? "dataset_sync_partial"
          : "dataset_sync_success",
    title: notificationTitle,
    body: notificationBodyParts.join(" · "),
    href: effectiveStatus === "failed" ? failureHref : successHref,
    meta: {
      trigger,
      datasetName: "Lateral",
      checkpointAdvanced,
      processingResult: checkpointAdvanced ? "SUCCESS" : null,
      failureCode: hardFailure?.code ?? null,
      failedStage: hardFailure?.failedStage ?? null,
      previousMasterPreserved: true,
      retryable: true,
      sourceFilename,
      sourceReceivedAt,
      adhocDsDateLabel,
      rowsImported: pipelineSummary?.rowsImported ?? 0,
      newCount: pipelineSummary?.newCount ?? 0,
      reopenCount: pipelineSummary?.reopenCount ?? 0,
      closedCount: pipelineSummary?.closedCount ?? 0,
      activeCount: pipelineSummary?.activeCount ?? 0,
      skippedCandidates,
    },
  }).catch(() => undefined);

  const formatEmailInfo = (parts: {
    sender?: string | null;
    subject?: string | null;
    messageId?: string | null;
    receivedAt?: string | null;
  }) => {
    const bits: string[] = [];
    if (parts.sender?.trim()) bits.push(parts.sender.trim());
    if (parts.subject?.trim()) bits.push(parts.subject.trim());
    if (bits.length === 0 && parts.messageId) {
      bits.push(`Message ${parts.messageId}`);
    }
    if (parts.receivedAt) {
      try {
        bits.push(new Date(parts.receivedAt).toLocaleString("en-IN"));
      } catch {
        bits.push(parts.receivedAt);
      }
    }
    return bits.length > 0 ? bits.join(" · ") : "—";
  };

  const syncSummary = {
    sourceEmail: formatEmailInfo({
      sender: failedItem?.sender || pending?.sender || lastUploaded?.sender,
      subject: failedItem?.subject || pending?.subject || lastUploaded?.subject,
      messageId:
        failedItem?.messageId ||
        pending?.messageId ||
        lastUploaded?.messageId ||
        syncResult?.checkpointBefore.messageId,
      receivedAt: sourceReceivedAt,
    }),
    originalFilename: sourceFilename || "—",
    // Note: a failedItem from an early failure (validation/download/etc.)
    // never has its own driveFileId — the file never reached Drive. Falling
    // back to pending/lastUploaded/checkpoint is correct ONLY when there is
    // no failedItem; when there IS one, showing an unrelated OLD Drive file
    // next to the NEW failed filename would be actively misleading, so that
    // fallback chain is skipped entirely in that case.
    googleDriveFileId: failedItem
      ? failedItem.driveFileId || "—"
      : pending?.driveFileId ||
        lastUploaded?.driveFileId ||
        syncResult?.checkpointBefore.driveFileId ||
        "—",
    sourceReceivedAt,
    rowsImported: pipelineSummary?.rowsImported ?? 0,
    newCount: pipelineSummary?.newCount ?? 0,
    activeCount: pipelineSummary?.activeCount ?? 0,
    reopenCount: pipelineSummary?.reopenCount ?? 0,
    closedCount: pipelineSummary?.closedCount ?? 0,
  };

  finishLateralRunProgress(
    hardFailure?.isHardFailure ? { skippedRemaining: true } : undefined
  );

  if (effectiveStatus === "success" && skippedCandidates.length > 0) {
    await logJobCompletedWithSkips({
      ranAt,
      trigger,
      skippedCandidates,
      sourceFilename,
    }).catch(() => undefined);
  }

  return {
    trigger,
    ranAt,
    status: effectiveStatus,
    message: hardFailure?.isHardFailure
      ? `${hardFailure.failedStage}: ${hardFailure.message}`
      : message,
    syncOk: syncOk && !hardFailure?.isHardFailure,
    skippedCandidates,
    pipelineOk:
      pipelineOk &&
      !hardFailure?.isHardFailure &&
      (pendingCheckpointAdvances.length === 0 || checkpointAdvanced),
    durationMs,
    checkpointAdvanced,
    failure: hardFailure
      ? {
          code: hardFailure.code,
          stage: hardFailure.stage,
          failedStage: hardFailure.failedStage,
          message: hardFailure.message,
          checkpointAdvanced: false,
          previousMasterPreserved: true,
          retryable: true,
          reportedSuccess: false,
          isHardFailure: hardFailure.isHardFailure,
        }
      : null,
    syncSummary,
  };
}
