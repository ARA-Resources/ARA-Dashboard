/**
 * Executive "Posted" button — Stage 3 adds the same test-hook injection and
 * detached fire-and-forget starter as `lateral-posted-run.ts`; see that
 * file's doc comment for the shared design. Postgres + Posted Sheet tab
 * only — the Executive Master Sheet Posted-cell Drive write was explicitly
 * dropped (2026-10-08): the live Master Sheet page reads Postgres, and the
 * Drive column is only a mirror Run All already refreshes.
 */
import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { drive_v3 } from "googleapis";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import { getDbClient } from "@/lib/persistence/db-client";
import { acquireExecutiveJobLock, type JobLockResult } from "@/lib/persistence/job-lock";
import {
  EXECUTIVE_POSTED_SHEET_TAB_NAME,
  resolveExecutivePostedSheetDriveFileId,
} from "@/services/executive-processing/executive-posted-sheet-config";
import { getExecutiveRunHolder } from "@/services/executive-processing/executive-run-progress";
import {
  beginExecutivePostedRun,
  completeExecutivePostedRun,
  getExecutivePostedSnapshot,
  getExecutivePostedHolder,
} from "@/services/executive-processing/executive-posted-progress";
import {
  fetchPostedWorkbookMeta,
  downloadPostedWorkbookToTemp,
  readPostedSheetTabRaw,
  type PostedWorkbookMeta,
} from "@/services/dataset-posted/posted-sheet-reader";
import { cleanPostedSheetRows } from "@/services/dataset-posted/posted-sheet-row-cleaner";
import {
  writePostedSheetLocal,
  type PostedSheetWriteRowInstruction,
} from "@/services/dataset-posted/posted-sheet-writer";
import { snapshotOtherTabs, findUnexpectedTabChanges } from "@/services/dataset-posted/posted-sheet-integrity-check";
import { withPostedDriveRetry } from "@/services/dataset-posted/posted-drive-retry";
import { uploadPostedWorkbookInPlace } from "@/services/dataset-posted/posted-drive-upload";
import { evaluatePostedWriteGuards, type PostedWriteGuardResult } from "@/services/dataset-posted/posted-write-guards";
import { isPostedWritesEnabled, postedWritesPolicyReason } from "@/lib/config/posted-writes-policy";
import { formatIstTime } from "@/services/dataset-posted/posted-time-format";
import { isPostedFakeDriveDemoActive, buildExecutiveDemoHooks } from "@/services/dataset-posted/posted-fake-drive-demo";
import { logPostedStepStart, logPostedStepEnd } from "@/services/dataset-posted/posted-timing-log";

export interface ExecutivePostedRunCounts {
  yes: number;
  notPosted: number;
  titleLinesRemoved: number;
  blankRowsRemoved: number;
  needsLook: number;
}

/**
 * Bypasses auth/file-id resolution entirely. Populated either by an
 * automated test calling this function directly, or — when no explicit
 * testHooks are given — by the double-gated demo provider in
 * `posted-fake-drive-demo.ts` (inert everywhere real Drive credentials
 * exist, which prod always does). No route or page ever passes this
 * directly.
 */
export interface ExecutivePostedTestHooks {
  drive: drive_v3.Drive;
  fileId: string;
}

export interface ExecutivePostedRunOptions {
  force?: boolean;
  testHooks?: ExecutivePostedTestHooks;
}

export type ExecutivePostedRunResult =
  | {
      ok: true;
      busy: false;
      previewOnly: boolean;
      counts: ExecutivePostedRunCounts;
      wouldSkipDriveUpload: boolean;
      message: string;
    }
  | { ok: false; busy: true; message: string }
  | { ok: false; busy: false; refused: true; message: string }
  | { ok: false; busy: false; refused: false; driveWarning: boolean; message: string };

export interface ExecutivePostedSummary {
  ranAt: string;
  yes: number;
  notPosted: number;
  titleLinesRemoved: number;
  blankRowsRemoved: number;
  needsLook: number;
  triggeredBy: "manual";
  previewOnly: boolean;
}

function buildSummaryText(counts: ExecutivePostedRunCounts): string {
  return `${counts.yes} Yes, ${counts.notPosted} not posted, ${counts.titleLinesRemoved} title/other lines removed, ${counts.blankRowsRemoved} blank rows removed, ${counts.needsLook} lines need a look`;
}

function buildGuardMessage(guard: PostedWriteGuardResult): string {
  if (guard.tripped && guard.reason === "zero_jr_ids") {
    return "Refused: zero JR IDs were found in the Posted Sheet. Nothing was changed.";
  }
  if (guard.tripped && guard.reason === "sharp_drop") {
    return `Refused: new Yes count (${guard.newYesCount}) is more than 35% below the current dashboard Yes count (${guard.currentYesCount}). Nothing was changed. Click "Run anyway" to proceed.`;
  }
  return "Refused. Nothing was changed.";
}

function driveWarningResult(detail: string): ExecutivePostedRunResult {
  return {
    ok: false,
    busy: false,
    refused: false,
    driveWarning: true,
    message: `Dashboard updated, Drive sheet NOT updated, click again. (${detail})`,
  };
}

function nothingChangedResult(detail: string): ExecutivePostedRunResult {
  return { ok: false, busy: false, refused: false, driveWarning: false, message: `${detail} Nothing was changed.` };
}

function isParseableIso(value: string | null | undefined): boolean {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

function resolveExecutiveBusyMessage(fallback: string): string {
  const runAll = getExecutiveRunHolder();
  if (runAll && isParseableIso(runAll.startedAt)) {
    const label = runAll.trigger === "scheduler" ? "scheduled" : "manual";
    return `Executive Run All (${label}) is running, started ${formatIstTime(runAll.startedAt)} IST`;
  }
  const postedHolder = getExecutivePostedHolder();
  if (postedHolder && isParseableIso(postedHolder.startedAt)) {
    return `Another Posted run is in progress, started ${formatIstTime(postedHolder.startedAt)} IST`;
  }
  return fallback || "A run is in progress.";
}

/** Full-refresh, match-based Postgres write — same semantics as `refreshExecutivePostedFromSheet`, taking the already-computed JR-ID set instead of re-reading Drive. */
async function syncExecutiveMasterPostedFromJrIds(uniqueJrIds: string[]): Promise<void> {
  const sql = getDbClient();
  const postedSet = new Set(uniqueJrIds);
  const masterRows = await sql<{ job_requisition_id: string; posted: string | null }[]>`
    SELECT job_requisition_id, posted FROM executive_master
  `;
  const yesIds: string[] = [];
  const dashIds: string[] = [];
  for (const row of masterRows) {
    if (postedSet.has(row.job_requisition_id)) yesIds.push(row.job_requisition_id);
    else dashIds.push(row.job_requisition_id);
  }
  await sql.begin(async (tx) => {
    const BATCH = 500;
    for (let i = 0; i < yesIds.length; i += BATCH) {
      const chunk = yesIds.slice(i, i + BATCH);
      await tx`UPDATE executive_master SET posted = 'Yes', updated_at = NOW() WHERE job_requisition_id = ANY(${chunk}) AND posted IS DISTINCT FROM 'Yes'`;
    }
    for (let i = 0; i < dashIds.length; i += BATCH) {
      const chunk = dashIds.slice(i, i + BATCH);
      await tx`UPDATE executive_master SET posted = '-', updated_at = NOW() WHERE job_requisition_id = ANY(${chunk}) AND posted IS DISTINCT FROM '-'`;
    }
  });
}

async function writeExecutivePostedSummary(summary: ExecutivePostedSummary): Promise<void> {
  const sql = getDbClient();
  await sql`
    UPDATE executive_scheduler_state
    SET last_posted_summary = ${sql.json(summary as never)}
    WHERE id = 1
  `;
}

export async function readExecutivePostedSummary(): Promise<ExecutivePostedSummary | null> {
  const sql = getDbClient();
  const rows = await sql<{ last_posted_summary: ExecutivePostedSummary | null }[]>`
    SELECT last_posted_summary FROM executive_scheduler_state WHERE id = 1
  `;
  return rows[0]?.last_posted_summary ?? null;
}

async function cleanupLocal(localPath: string | null): Promise<void> {
  if (!localPath) return;
  await fs.unlink(localPath).catch(() => undefined);
}

async function executeExecutivePostedWork(
  lock: JobLockResult,
  runId: string,
  options?: ExecutivePostedRunOptions
): Promise<ExecutivePostedRunResult> {
  const force = options?.force === true;
  const hooks = options?.testHooks ?? ((await isPostedFakeDriveDemoActive()) ? await buildExecutiveDemoHooks() : undefined);
  let localPath: string | null = null;
  let postgresAlreadyUpdated = false;

  try {
    let fileId: string;
    let drive: drive_v3.Drive;

    if (hooks) {
      fileId = hooks.fileId;
      drive = hooks.drive;
    } else {
      try {
        fileId = resolveExecutivePostedSheetDriveFileId();
      } catch (error) {
        const result = nothingChangedResult(
          error instanceof Error ? `Posted Sheet source is not configured: ${error.message}` : "Posted Sheet source is not configured."
        );
        completeExecutivePostedRun(runId, result);
        return result;
      }
      drive = (await getAuthorizedGmailClient()).drive;
    }

    let meta: PostedWorkbookMeta;
    const downloadStartedAt = logPostedStepStart("executive", "Drive download");
    try {
      meta = await withPostedDriveRetry(() => fetchPostedWorkbookMeta(drive, fileId), "Drive metadata read");
      localPath = await withPostedDriveRetry(() => downloadPostedWorkbookToTemp(drive, fileId, meta.fileName), "Drive download");
    } catch (error) {
      logPostedStepEnd("executive", "Drive download (failed)", downloadStartedAt);
      const result = nothingChangedResult(error instanceof Error ? error.message : "Drive download failed.");
      completeExecutivePostedRun(runId, result);
      return result;
    }
    logPostedStepEnd("executive", "Drive download", downloadStartedAt);

    const sheet = await readPostedSheetTabRaw(localPath, EXECUTIVE_POSTED_SHEET_TAB_NAME);
    if (!sheet.ok) {
      const result = nothingChangedResult(sheet.reason);
      completeExecutivePostedRun(runId, result);
      return result;
    }

    const cleaned = cleanPostedSheetRows(sheet.rows);
    const uniqueJrIds = [...new Set(cleaned.kept.map((r) => r.jobRequisitionId).filter(Boolean))];

    const sql = getDbClient();
    let matchedSet = new Set<string>();
    if (uniqueJrIds.length > 0) {
      const matched = await sql<{ job_requisition_id: string }[]>`
        SELECT job_requisition_id FROM executive_master WHERE job_requisition_id = ANY(${sql.array(uniqueJrIds)})
      `;
      matchedSet = new Set(matched.map((m) => m.job_requisition_id));
    }
    const yes = matchedSet.size;
    const notPosted = uniqueJrIds.length - yes;

    const counts: ExecutivePostedRunCounts = {
      yes,
      notPosted,
      titleLinesRemoved: cleaned.noJrIdRowsRemoved,
      blankRowsRemoved: cleaned.blankRowsRemoved,
      needsLook: cleaned.needsLookCount,
    };

    if (!isPostedWritesEnabled()) {
      const result: ExecutivePostedRunResult = {
        ok: true,
        busy: false,
        previewOnly: true,
        counts,
        wouldSkipDriveUpload: !cleaned.changed,
        message: `Preview only, writes are off (${postedWritesPolicyReason()}). Posted would update: ${buildSummaryText(counts)}.`,
      };
      completeExecutivePostedRun(runId, result);
      return result;
    }

    const [currentYesRow] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM executive_master WHERE posted = 'Yes'
    `;
    const currentYesCount = currentYesRow?.count ?? 0;
    const guard = evaluatePostedWriteGuards({ uniqueJrIdCount: uniqueJrIds.length, newYesCount: yes, currentYesCount, force });
    if (guard.tripped) {
      const result: ExecutivePostedRunResult = { ok: false, busy: false, refused: true, message: buildGuardMessage(guard) };
      completeExecutivePostedRun(runId, result);
      return result;
    }

    // --- Postgres FIRST ---
    const postgresWriteStartedAt = logPostedStepStart("executive", "Postgres write");
    await syncExecutiveMasterPostedFromJrIds(uniqueJrIds);
    postgresAlreadyUpdated = true;
    logPostedStepEnd("executive", "Postgres write", postgresWriteStartedAt);

    if (!cleaned.changed) {
      await writeExecutivePostedSummary({
        ranAt: new Date().toISOString(),
        yes,
        notPosted,
        titleLinesRemoved: counts.titleLinesRemoved,
        blankRowsRemoved: counts.blankRowsRemoved,
        needsLook: counts.needsLook,
        triggeredBy: "manual",
        previewOnly: false,
      });
      const result: ExecutivePostedRunResult = {
        ok: true,
        busy: false,
        previewOnly: false,
        counts,
        wouldSkipDriveUpload: true,
        message: `Sheet was already clean, no Drive changes. Posted updated: ${buildSummaryText(counts)}.`,
      };
      completeExecutivePostedRun(runId, result);
      return result;
    }

    const excludeFromIntegrityCheck = [EXECUTIVE_POSTED_SHEET_TAB_NAME];
    const beforeSnapshot = await snapshotOtherTabs(localPath, excludeFromIntegrityCheck);
    if (!beforeSnapshot.ok) {
      const result = driveWarningResult(`Could not verify other tabs before editing: ${beforeSnapshot.reason}`);
      completeExecutivePostedRun(runId, result);
      return result;
    }

    const rowsToWrite: PostedSheetWriteRowInstruction[] = cleaned.rows
      .filter((r) => r.kind === "clean" || r.kind === "needsLook")
      .map((r) =>
        r.kind === "clean"
          ? { rowNumber: r.rowNumber, columnA: r.columnA, columnB: r.jobRequisitionId, columnC: matchedSet.has(r.jobRequisitionId) ? "Yes" : "-" }
          : { rowNumber: r.rowNumber, columnA: null, columnB: r.jobRequisitionId, columnC: matchedSet.has(r.jobRequisitionId) ? "Yes" : "-" }
      );
    const rowsToDelete = cleaned.rows.filter((r) => r.kind === "deleteBlank" || r.kind === "deleteNoJrId").map((r) => r.rowNumber);

    // No masterColumnWrite — the Executive Master Sheet Posted-cell Drive
    // write was explicitly dropped. Postgres + Posted Sheet tab only.
    const writeResult = await writePostedSheetLocal({
      localPath,
      postedSheetName: EXECUTIVE_POSTED_SHEET_TAB_NAME,
      rowsToDelete,
      rowsToWrite,
    });
    if (!writeResult.ok) {
      const result = driveWarningResult(`Local edit failed: ${writeResult.reason}`);
      completeExecutivePostedRun(runId, result);
      return result;
    }

    const afterSnapshot = await snapshotOtherTabs(localPath, excludeFromIntegrityCheck);
    if (!afterSnapshot.ok) {
      const result = driveWarningResult(`Could not verify other tabs after editing: ${afterSnapshot.reason}`);
      completeExecutivePostedRun(runId, result);
      return result;
    }
    const unexpected = findUnexpectedTabChanges(beforeSnapshot.hashes, afterSnapshot.hashes);
    if (unexpected.length > 0) {
      const result = driveWarningResult(`Internal safety check failed: unexpected changes on ${unexpected.join(", ")} — nothing was uploaded to Drive.`);
      completeExecutivePostedRun(runId, result);
      return result;
    }

    let latestMeta: PostedWorkbookMeta;
    try {
      latestMeta = await fetchPostedWorkbookMeta(drive, fileId);
    } catch (error) {
      const result = driveWarningResult(`Could not re-check the Drive file before uploading: ${error instanceof Error ? error.message : String(error)}`);
      completeExecutivePostedRun(runId, result);
      return result;
    }
    const modifiedTimeChanged = meta.modifiedTime !== null && latestMeta.modifiedTime !== null && meta.modifiedTime !== latestMeta.modifiedTime;
    const revisionChanged = meta.headRevisionId !== null && latestMeta.headRevisionId !== null && meta.headRevisionId !== latestMeta.headRevisionId;
    if (modifiedTimeChanged || revisionChanged) {
      const result = driveWarningResult("Someone else edited the workbook while this was running — nothing was uploaded to Drive.");
      completeExecutivePostedRun(runId, result);
      return result;
    }

    const uploadStartedAt = logPostedStepStart("executive", "Drive upload");
    try {
      await withPostedDriveRetry(() => uploadPostedWorkbookInPlace(drive, fileId, localPath as string), "Drive upload");
      logPostedStepEnd("executive", "Drive upload", uploadStartedAt);
    } catch (error) {
      logPostedStepEnd("executive", "Drive upload (failed)", uploadStartedAt);
      const result = driveWarningResult(`Drive upload failed: ${error instanceof Error ? error.message : String(error)}`);
      completeExecutivePostedRun(runId, result);
      return result;
    }

    await writeExecutivePostedSummary({
      ranAt: new Date().toISOString(),
      yes,
      notPosted,
      titleLinesRemoved: counts.titleLinesRemoved,
      blankRowsRemoved: counts.blankRowsRemoved,
      needsLook: counts.needsLook,
      triggeredBy: "manual",
      previewOnly: false,
    });

    const result: ExecutivePostedRunResult = {
      ok: true,
      busy: false,
      previewOnly: false,
      counts,
      wouldSkipDriveUpload: false,
      message: `Posted updated: ${buildSummaryText(counts)}.`,
    };
    completeExecutivePostedRun(runId, result);
    return result;
  } catch (error) {
    const result = postgresAlreadyUpdated
      ? driveWarningResult(error instanceof Error ? error.message : "Unexpected error after Postgres was updated.")
      : nothingChangedResult(error instanceof Error ? error.message : "Posted run failed unexpectedly.");
    completeExecutivePostedRun(runId, result);
    return result;
  } finally {
    await cleanupLocal(localPath);
    await lock.release();
  }
}

export async function runExecutivePostedButton(options?: ExecutivePostedRunOptions): Promise<ExecutivePostedRunResult> {
  const lock = await acquireExecutiveJobLock();
  if (!lock.acquired) {
    return { ok: false, busy: true, message: resolveExecutiveBusyMessage(lock.message) };
  }
  const runId = crypto.randomUUID();
  beginExecutivePostedRun(runId);
  return executeExecutivePostedWork(lock, runId, options);
}

export async function startExecutivePostedRunDetached(
  options?: ExecutivePostedRunOptions
): Promise<{ started: true; runId: string } | { started: false; message: string }> {
  const lock = await acquireExecutiveJobLock();
  if (!lock.acquired) {
    return { started: false, message: resolveExecutiveBusyMessage(lock.message) };
  }
  const runId = crypto.randomUUID();
  beginExecutivePostedRun(runId);
  void executeExecutivePostedWork(lock, runId, options).catch((error) => {
    completeExecutivePostedRun(runId, driveWarningResult(error instanceof Error ? error.message : "Unexpected error."));
  });
  return { started: true, runId };
}

export function getExecutivePostedRunStatus() {
  return getExecutivePostedSnapshot<ExecutivePostedRunResult>();
}
