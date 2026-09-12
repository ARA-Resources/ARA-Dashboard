/**
 * Phase E4 — Executive job orchestrator ("Run All" entry point).
 *
 * Chains: acquireExecutiveJobLock() -> Gmail sync (E2) -> reconcile (E3) ->
 * Gmail checkpoint advance, exactly mirroring how `lateral-job.ts`'s
 * `executeLateralDatasetJob` sequences Lateral's own stages and only calls
 * `advanceFinalLateralGmailCheckpoint` after its pipeline stage succeeds.
 *
 * Rules (never violated):
 * - The Executive advisory lock (EXECUTIVE_JOB_LOCK_KEY) is the FIRST thing
 *   acquired and the LAST thing released. A second concurrent call must
 *   short-circuit to `status: "busy"` before ever touching Gmail/Drive/DB.
 * - The Gmail checkpoint advances ONLY after `reconcileExecutiveMasterFromBaseDs`
 *   returns `ok: true`. Any failure — sync failure, reconcile failure, or the
 *   checkpoint write itself failing — reports `status: "failed"` and never
 *   advances the checkpoint, so the next run retries the same source email.
 * - Never reports "success" while `checkpointAdvanced` is false AND a new
 *   source was actually found (mirrors Lateral's "never report success on
 *   failure" invariant, enforced structurally here rather than via a
 *   separate guard function since Executive's job is much shorter).
 * - Phase E6: after a successful reconcile, also refreshes `posted` from the
 *   Posted Sheet (`refreshExecutivePostedFromSheet`) — best-effort. A Posted
 *   Sheet read failure (empty/unreadable) never fails the overall job,
 *   never blocks the checkpoint advance, and never touches `posted` for
 *   anyone (skip + warn only). Mirrors Lateral's own Posted Sheet step being
 *   part of the same pipeline run that processed new source data — it does
 *   NOT run on the "no new demand sheet" idle path, same as Lateral's
 *   Posted-matching step never runs on an idle tick either.
 *
 * This module builds the callable orchestrator only. No HTTP route, no
 * Dataset Manager "Run All" button, and no scheduler/cron caller exist yet —
 * those are Phase E8 (UI) and Phase E5 (cron) respectively. Nothing here is
 * reachable from a live trigger.
 */
import {
  acquireExecutiveJobLock,
  type JobLockResult,
} from "@/lib/persistence/job-lock";
import { advanceExecutiveGmailCheckpoint } from "@/services/executive-processing/executive-gmail-checkpoint-store";
import {
  runExecutiveGmailIncrementalSync,
  type ExecutiveIncrementalSyncResult,
} from "@/services/executive-processing/executive-gmail-incremental-sync";
import { reconcileExecutiveMasterFromBaseDs } from "@/services/executive-processing/executive-master-reconcile-postgres";
import { refreshExecutivePostedFromSheet } from "@/services/executive-processing/executive-posted-refresh";
import type {
  ExecutiveJobOutcome,
  ExecutiveJobTrigger,
  ExecutiveRunLastSummary,
} from "@/types/executive-scheduler";

function formatDdMmYyyy(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  return `${dd}-${mm}-${yyyy}`;
}

/** Injectable for testing without live Gmail/Drive credentials. */
export interface InvokeExecutiveJobDeps {
  acquireLock?: () => Promise<JobLockResult>;
  runSync?: () => Promise<ExecutiveIncrementalSyncResult>;
  reconcile?: typeof reconcileExecutiveMasterFromBaseDs;
  advanceCheckpoint?: typeof advanceExecutiveGmailCheckpoint;
  refreshPosted?: typeof refreshExecutivePostedFromSheet;
}

export async function invokeExecutiveJob(
  trigger: ExecutiveJobTrigger,
  deps?: InvokeExecutiveJobDeps
): Promise<ExecutiveJobOutcome> {
  const ranAt = new Date().toISOString();
  const startedMs = Date.now();
  const acquireLock = deps?.acquireLock ?? acquireExecutiveJobLock;

  const lock = await acquireLock();
  if (!lock.acquired) {
    return {
      trigger,
      ranAt,
      status: "busy",
      message: lock.message,
      durationMs: Math.max(0, Date.now() - startedMs),
      lockAcquired: false,
      syncOk: false,
      reconcileOk: false,
      checkpointAdvanced: false,
      postedRefreshOk: null,
      summary: null,
    };
  }

  try {
    return await invokeExecutiveJobBody(trigger, ranAt, startedMs, deps);
  } finally {
    await lock.release();
  }
}

async function invokeExecutiveJobBody(
  trigger: ExecutiveJobTrigger,
  ranAt: string,
  startedMs: number,
  deps?: InvokeExecutiveJobDeps
): Promise<ExecutiveJobOutcome> {
  const runSync = deps?.runSync ?? runExecutiveGmailIncrementalSync;
  const reconcile = deps?.reconcile ?? reconcileExecutiveMasterFromBaseDs;
  const advanceCheckpoint =
    deps?.advanceCheckpoint ?? advanceExecutiveGmailCheckpoint;

  const durationMs = () => Math.max(0, Date.now() - startedMs);
  const baseSummary = (
    partial: Partial<ExecutiveRunLastSummary>
  ): ExecutiveRunLastSummary => ({
    result: "failed",
    ranAt,
    trigger,
    sourceFilename: null,
    sender: null,
    subject: null,
    driveFileId: null,
    messageId: null,
    demandSheetDate: null,
    demandSheetDateLabel: "No new Executive demand sheet on last run",
    failureReason: null,
    noNewSource: false,
    counts: null,
    postedRefresh: null,
    ...partial,
  });

  let syncResult: ExecutiveIncrementalSyncResult;
  try {
    syncResult = await runSync();
  } catch (error) {
    const failureReason =
      error instanceof Error
        ? error.message
        : "Executive Gmail sync failed.";
    return {
      trigger,
      ranAt,
      status: "failed",
      message: `FAILED at gmail_sync: ${failureReason}`,
      durationMs: durationMs(),
      lockAcquired: true,
      syncOk: false,
      reconcileOk: false,
      checkpointAdvanced: false,
      postedRefreshOk: null,
      summary: baseSummary({ failureReason }),
    };
  }

  if (syncResult.failedCount > 0 || syncResult.stoppedOnFailure) {
    const failedItem = syncResult.items.find((i) => i.error);
    const failureReason = failedItem?.error || syncResult.message;
    return {
      trigger,
      ranAt,
      status: "failed",
      message: `FAILED at gmail_sync: ${failureReason}. Checkpoint NOT advanced.`,
      durationMs: durationMs(),
      lockAcquired: true,
      syncOk: false,
      reconcileOk: false,
      checkpointAdvanced: false,
      postedRefreshOk: null,
      summary: baseSummary({ failureReason }),
    };
  }

  const pending = syncResult.pendingCheckpointAdvances;
  if (pending.length === 0) {
    const message = `No new Executive demand-sheet emails. ${syncResult.message}`;
    return {
      trigger,
      ranAt,
      status: "success",
      message,
      durationMs: durationMs(),
      lockAcquired: true,
      syncOk: true,
      reconcileOk: false,
      checkpointAdvanced: false,
      // No new demand sheet -> no reconcile ran -> Posted refresh does not
      // run either, same as Lateral's Posted-matching step never running on
      // an idle tick with no new source.
      postedRefreshOk: null,
      summary: baseSummary({
        result: "success",
        noNewSource: true,
        failureReason: null,
      }),
    };
  }

  // Full-snapshot demand sheet: only the newest pending upload matters —
  // any earlier ones in this batch are superseded snapshots.
  const last = pending[pending.length - 1];
  if (!last.localWorkbookPath) {
    const failureReason =
      "Internal error: uploaded demand sheet has no local workbook path for reconcile.";
    return {
      trigger,
      ranAt,
      status: "failed",
      message: `FAILED at reconcile: ${failureReason}. Checkpoint NOT advanced.`,
      durationMs: durationMs(),
      lockAcquired: true,
      syncOk: true,
      reconcileOk: false,
      checkpointAdvanced: false,
      postedRefreshOk: null,
      summary: baseSummary({
        sourceFilename: last.attachmentFilename,
        sender: last.sender ?? null,
        subject: last.subject ?? null,
        driveFileId: last.driveFileId,
        messageId: last.messageId,
        failureReason,
      }),
    };
  }

  let reconcileResult: Awaited<ReturnType<typeof reconcile>>;
  try {
    reconcileResult = await reconcile({
      localWorkbookPath: last.localWorkbookPath,
    });
  } catch (error) {
    const failureReason =
      error instanceof Error
        ? error.message
        : "Executive master reconcile failed.";
    return {
      trigger,
      ranAt,
      status: "failed",
      message: `FAILED at reconcile: ${failureReason}. Checkpoint NOT advanced.`,
      durationMs: durationMs(),
      lockAcquired: true,
      syncOk: true,
      reconcileOk: false,
      checkpointAdvanced: false,
      postedRefreshOk: null,
      summary: baseSummary({
        sourceFilename: last.attachmentFilename,
        sender: last.sender ?? null,
        subject: last.subject ?? null,
        driveFileId: last.driveFileId,
        messageId: last.messageId,
        failureReason,
      }),
    };
  }

  if (!reconcileResult.ok) {
    return {
      trigger,
      ranAt,
      status: "failed",
      message: `FAILED at reconcile: ${reconcileResult.error}. Checkpoint NOT advanced — next run retries the same source email.`,
      durationMs: durationMs(),
      lockAcquired: true,
      syncOk: true,
      reconcileOk: false,
      checkpointAdvanced: false,
      postedRefreshOk: null,
      summary: baseSummary({
        sourceFilename: last.attachmentFilename,
        sender: last.sender ?? null,
        subject: last.subject ?? null,
        driveFileId: last.driveFileId,
        messageId: last.messageId,
        failureReason: reconcileResult.error,
      }),
    };
  }

  const demandSheetDate = formatDdMmYyyy(last.receivedAt);
  const counts = {
    rowsImported: reconcileResult.counts.demandRowCount,
    newCount: reconcileResult.counts.added,
    activeCount: reconcileResult.counts.activated,
    reopenCount: reconcileResult.counts.reopened,
    closedCount: reconcileResult.counts.closed,
  };

  // Phase E6: best-effort Posted refresh now that executive_master reflects
  // today's demand sheet. Never throws — refreshExecutivePostedFromSheet
  // returns a typed ok:false on any unreadable-source condition instead.
  const refreshPosted = deps?.refreshPosted ?? refreshExecutivePostedFromSheet;
  const postedResult = await refreshPosted();
  const postedRefreshSummary: ExecutiveRunLastSummary["postedRefresh"] = postedResult.ok
    ? {
        ok: true,
        message: postedResult.message,
        postedYes: postedResult.counts.postedYes,
        postedDash: postedResult.counts.postedDash,
      }
    : {
        ok: false,
        message: postedResult.message,
        postedYes: null,
        postedDash: null,
      };

  try {
    await advanceCheckpoint({
      messageId: last.messageId,
      attachmentId: last.attachmentId,
      receivedAt: last.receivedAt,
      receivedAtMs: last.receivedAtMs,
      attachmentFilename: last.attachmentFilename,
      driveFileId: last.driveFileId,
      processingResult: "SUCCESS",
    });
  } catch (error) {
    // Reconcile already committed (executive_master reflects today's demand
    // sheet), but the checkpoint write itself failed. Report failed so the
    // next run retries — reconcile is a full-snapshot upsert, so re-running
    // it against the same source is safe/idempotent, unlike Lateral's XLSM
    // save which cannot be blindly retried the same way.
    const failureReason =
      error instanceof Error
        ? error.message
        : "Executive Gmail checkpoint write failed.";
    return {
      trigger,
      ranAt,
      status: "failed",
      message: `Reconcile succeeded but checkpoint advance FAILED: ${failureReason}. Next run will retry.`,
      durationMs: durationMs(),
      lockAcquired: true,
      syncOk: true,
      reconcileOk: true,
      checkpointAdvanced: false,
      postedRefreshOk: postedResult.ok,
      summary: baseSummary({
        sourceFilename: last.attachmentFilename,
        sender: last.sender ?? null,
        subject: last.subject ?? null,
        driveFileId: last.driveFileId,
        messageId: last.messageId,
        demandSheetDate,
        demandSheetDateLabel: demandSheetDate
          ? `Last demand sheet: ${demandSheetDate}`
          : "No new Executive demand sheet on last run",
        failureReason,
        counts,
        postedRefresh: postedRefreshSummary,
      }),
    };
  }

  return {
    trigger,
    ranAt,
    status: "success",
    message: `${reconcileResult.message} Checkpoint advanced (messageId=${last.messageId}, driveFileId=${last.driveFileId}). ${postedResult.message}`,
    durationMs: durationMs(),
    lockAcquired: true,
    syncOk: true,
    reconcileOk: true,
    checkpointAdvanced: true,
    postedRefreshOk: postedResult.ok,
    summary: baseSummary({
      result: "success",
      sourceFilename: last.attachmentFilename,
      sender: last.sender ?? null,
      subject: last.subject ?? null,
      driveFileId: last.driveFileId,
      messageId: last.messageId,
      demandSheetDate,
      demandSheetDateLabel: demandSheetDate
        ? `Last demand sheet: ${demandSheetDate}`
        : "No new Executive demand sheet on last run",
      failureReason: null,
      counts,
      postedRefresh: postedRefreshSummary,
    }),
  };
}
