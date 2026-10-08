/**
 * Lateral "Posted" button — Stage 3 adds: test-only Drive/file injection
 * (`testHooks`, never used by production code — no route or page passes
 * it), and a detached fire-and-forget starter for the API route, mirroring
 * `lateral-scheduler.ts`'s own established `startLateralJobAsync` pattern
 * exactly (acquire lock synchronously, decide busy-or-started immediately,
 * let the actual work continue after the HTTP response via `void
 * promise.catch(...)`, progress/result read back separately by polling).
 *
 * See the Stage 2 version of this file's doc comment for the full write
 * ordering and failure-message rules — unchanged here.
 */
import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { drive_v3 } from "googleapis";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import { getDbClient } from "@/lib/persistence/db-client";
import { acquireLateralJobLock, type JobLockResult } from "@/lib/persistence/job-lock";
import {
  discoverLateralMasterWorkbook,
  validatePipelineRequiredWorksheets,
  LateralMasterDiscoveryError,
} from "@/services/lateral-processing/lateral-master-workbook-discovery";
import {
  POSTED_JR_HEADER,
  MASTER_POSTED_HEADER,
} from "@/services/lateral-processing/lateral-posted-sheet-processor";
import { syncLateralPostedStatus } from "@/services/lateral-processing/lateral-master-postgres";
import { getLateralRunProgress } from "@/services/lateral-processing/lateral-run-progress";
import {
  beginLateralPostedRun,
  completeLateralPostedRun,
  getLateralPostedSnapshot,
  getLateralPostedHolder,
} from "@/services/lateral-processing/lateral-posted-progress";
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
import { isPostedFakeDriveDemoActive, buildLateralDemoHooks } from "@/services/dataset-posted/posted-fake-drive-demo";
import { logPostedStepStart, logPostedStepEnd } from "@/services/dataset-posted/posted-timing-log";

export interface LateralPostedRunCounts {
  yes: number;
  notPosted: number;
  titleLinesRemoved: number;
  blankRowsRemoved: number;
  needsLook: number;
}

/**
 * Bypasses discovery/auth entirely. Populated either by an automated test
 * calling this function directly, or — when no explicit testHooks are
 * given — by the double-gated demo provider in
 * `posted-fake-drive-demo.ts` (inert everywhere real Drive credentials
 * exist, which prod always does). No route or page ever passes this
 * directly.
 */
export interface LateralPostedTestHooks {
  drive: drive_v3.Drive;
  fileId: string;
  fileName: string;
  masterSheet: string;
  postedSheet: string;
}

export interface LateralPostedRunOptions {
  force?: boolean;
  testHooks?: LateralPostedTestHooks;
}

export type LateralPostedRunResult =
  | {
      ok: true;
      busy: false;
      previewOnly: boolean;
      counts: LateralPostedRunCounts;
      wouldSkipDriveUpload: boolean;
      message: string;
    }
  | { ok: false; busy: true; message: string }
  | { ok: false; busy: false; refused: true; message: string }
  | { ok: false; busy: false; refused: false; driveWarning: boolean; message: string };

export interface LateralPostedSummary {
  ranAt: string;
  yes: number;
  notPosted: number;
  titleLinesRemoved: number;
  blankRowsRemoved: number;
  needsLook: number;
  triggeredBy: "manual";
  previewOnly: boolean;
}

function buildSummaryText(counts: LateralPostedRunCounts): string {
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

function driveWarningResult(detail: string): LateralPostedRunResult {
  return {
    ok: false,
    busy: false,
    refused: false,
    driveWarning: true,
    message: `Dashboard updated, Drive sheet NOT updated, click again. (${detail})`,
  };
}

function nothingChangedResult(detail: string): LateralPostedRunResult {
  return { ok: false, busy: false, refused: false, driveWarning: false, message: `${detail} Nothing was changed.` };
}

function isParseableIso(value: string | null | undefined): boolean {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

function resolveLateralBusyMessage(fallback: string): string {
  const runAll = getLateralRunProgress();
  if (runAll.active && isParseableIso(runAll.startedAt)) {
    const label = runAll.trigger === "scheduler" ? "scheduled" : "manual";
    return `Lateral Run All (${label}) is running, started ${formatIstTime(runAll.startedAt)} IST`;
  }
  const postedHolder = getLateralPostedHolder();
  if (postedHolder && isParseableIso(postedHolder.startedAt)) {
    return `Another Posted run is in progress, started ${formatIstTime(postedHolder.startedAt)} IST`;
  }
  // Holder marker missing/expired/unreadable — never blank, never guess wrong.
  return fallback || "A run is in progress.";
}

async function writeLateralPostedSummary(summary: LateralPostedSummary): Promise<void> {
  const sql = getDbClient();
  await sql`
    UPDATE lateral_scheduler_state
    SET last_posted_summary = ${sql.json(summary as never)}
    WHERE id = (SELECT id FROM lateral_scheduler_state ORDER BY id LIMIT 1)
  `;
}

export async function readLateralPostedSummary(): Promise<LateralPostedSummary | null> {
  const sql = getDbClient();
  const rows = await sql<{ last_posted_summary: LateralPostedSummary | null }[]>`
    SELECT last_posted_summary FROM lateral_scheduler_state ORDER BY id LIMIT 1
  `;
  return rows[0]?.last_posted_summary ?? null;
}

async function cleanupLocal(localPath: string | null): Promise<void> {
  if (!localPath) return;
  await fs.unlink(localPath).catch(() => undefined);
}

/**
 * Everything AFTER the lock is held. Shared by the synchronous tester
 * (`runLateralPostedButton`) and the detached starter
 * (`startLateralPostedRunDetached`) so there is exactly one implementation
 * of the actual work, same principle as `runAndPersistLateralJob`.
 */
async function executeLateralPostedWork(
  lock: JobLockResult,
  runId: string,
  options?: LateralPostedRunOptions
): Promise<LateralPostedRunResult> {
  const force = options?.force === true;
  const hooks = options?.testHooks ?? ((await isPostedFakeDriveDemoActive()) ? await buildLateralDemoHooks() : undefined);
  let localPath: string | null = null;
  let postgresAlreadyUpdated = false;

  try {
    let fileId: string;
    let fileName: string;
    let masterSheetName: string;
    let postedSheetName: string;
    let drive: drive_v3.Drive;

    if (hooks) {
      fileId = hooks.fileId;
      fileName = hooks.fileName;
      masterSheetName = hooks.masterSheet;
      postedSheetName = hooks.postedSheet;
      drive = hooks.drive;
    } else {
      const discovery = await discoverLateralMasterWorkbook();
      const sheets = validatePipelineRequiredWorksheets({ availableWorksheets: discovery.availableWorksheets });
      if (!sheets.ok) {
        const result = nothingChangedResult(`Posted Sheet / P-Roles worksheet missing: ${sheets.missing.join(", ")}.`);
        completeLateralPostedRun(runId, result);
        return result;
      }
      fileId = discovery.fileId;
      fileName = discovery.fileName;
      masterSheetName = discovery.masterSheet;
      postedSheetName = sheets.postedSheet;
      drive = (await getAuthorizedGmailClient()).drive;
    }

    let meta: PostedWorkbookMeta;
    const downloadStartedAt = logPostedStepStart("lateral", "Drive download");
    try {
      meta = await withPostedDriveRetry(() => fetchPostedWorkbookMeta(drive, fileId), "Drive metadata read");
      localPath = await withPostedDriveRetry(() => downloadPostedWorkbookToTemp(drive, fileId, fileName), "Drive download");
    } catch (error) {
      logPostedStepEnd("lateral", "Drive download (failed)", downloadStartedAt);
      const result = nothingChangedResult(error instanceof Error ? error.message : "Drive download failed.");
      completeLateralPostedRun(runId, result);
      return result;
    }
    logPostedStepEnd("lateral", "Drive download", downloadStartedAt);

    const sheet = await readPostedSheetTabRaw(localPath, postedSheetName);
    if (!sheet.ok) {
      const result = nothingChangedResult(sheet.reason);
      completeLateralPostedRun(runId, result);
      return result;
    }

    const cleaned = cleanPostedSheetRows(sheet.rows);
    const uniqueJrIds = [...new Set(cleaned.kept.map((r) => r.jobRequisitionId).filter(Boolean))];

    const sql = getDbClient();
    let matchedSet = new Set<string>();
    if (uniqueJrIds.length > 0) {
      const matched = await sql<{ job_requisition_id: string }[]>`
        SELECT job_requisition_id FROM lateral_master WHERE job_requisition_id = ANY(${sql.array(uniqueJrIds)})
      `;
      matchedSet = new Set(matched.map((m) => m.job_requisition_id));
    }
    const yes = matchedSet.size;
    const notPosted = uniqueJrIds.length - yes;

    const counts: LateralPostedRunCounts = {
      yes,
      notPosted,
      titleLinesRemoved: cleaned.noJrIdRowsRemoved,
      blankRowsRemoved: cleaned.blankRowsRemoved,
      needsLook: cleaned.needsLookCount,
    };

    if (!isPostedWritesEnabled()) {
      const result: LateralPostedRunResult = {
        ok: true,
        busy: false,
        previewOnly: true,
        counts,
        wouldSkipDriveUpload: !cleaned.changed,
        message: `Preview only, writes are off (${postedWritesPolicyReason()}). Posted would update: ${buildSummaryText(counts)}.`,
      };
      completeLateralPostedRun(runId, result);
      return result;
    }

    const [currentYesRow] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM lateral_master WHERE posted = 'Yes'
    `;
    const currentYesCount = currentYesRow?.count ?? 0;
    const guard = evaluatePostedWriteGuards({ uniqueJrIdCount: uniqueJrIds.length, newYesCount: yes, currentYesCount, force });
    if (guard.tripped) {
      const result: LateralPostedRunResult = { ok: false, busy: false, refused: true, message: buildGuardMessage(guard) };
      completeLateralPostedRun(runId, result);
      return result;
    }

    // --- Postgres FIRST ---
    const postgresWriteStartedAt = logPostedStepStart("lateral", "Postgres write");
    await syncLateralPostedStatus(uniqueJrIds, true);
    postgresAlreadyUpdated = true;
    logPostedStepEnd("lateral", "Postgres write", postgresWriteStartedAt);

    if (!cleaned.changed) {
      await writeLateralPostedSummary({
        ranAt: new Date().toISOString(),
        yes,
        notPosted,
        titleLinesRemoved: counts.titleLinesRemoved,
        blankRowsRemoved: counts.blankRowsRemoved,
        needsLook: counts.needsLook,
        triggeredBy: "manual",
        previewOnly: false,
      });
      const result: LateralPostedRunResult = {
        ok: true,
        busy: false,
        previewOnly: false,
        counts,
        wouldSkipDriveUpload: true,
        message: `Sheet was already clean, no Drive changes. Posted updated: ${buildSummaryText(counts)}.`,
      };
      completeLateralPostedRun(runId, result);
      return result;
    }

    const excludeFromIntegrityCheck = [postedSheetName, masterSheetName];
    const beforeSnapshot = await snapshotOtherTabs(localPath, excludeFromIntegrityCheck);
    if (!beforeSnapshot.ok) {
      const result = driveWarningResult(`Could not verify other tabs before editing: ${beforeSnapshot.reason}`);
      completeLateralPostedRun(runId, result);
      return result;
    }

    const rowsToWrite: PostedSheetWriteRowInstruction[] = cleaned.rows
      .filter((r) => r.kind === "clean" || r.kind === "needsLook")
      .map((r) =>
        r.kind === "clean"
          ? { rowNumber: r.rowNumber, columnA: r.columnA, columnB: r.jobRequisitionId, columnC: matchedSet.has(r.jobRequisitionId) ? "Yes" : "No" }
          : { rowNumber: r.rowNumber, columnA: null, columnB: r.jobRequisitionId, columnC: matchedSet.has(r.jobRequisitionId) ? "Yes" : "No" }
      );
    const rowsToDelete = cleaned.rows.filter((r) => r.kind === "deleteBlank" || r.kind === "deleteNoJrId").map((r) => r.rowNumber);

    const writeResult = await writePostedSheetLocal({
      localPath,
      postedSheetName,
      rowsToDelete,
      rowsToWrite,
      masterColumnWrite: {
        sheetName: masterSheetName,
        jrHeader: POSTED_JR_HEADER,
        postedHeader: MASTER_POSTED_HEADER,
        matchedJrIds: [...matchedSet],
      },
    });
    if (!writeResult.ok) {
      const result = driveWarningResult(`Local edit failed: ${writeResult.reason}`);
      completeLateralPostedRun(runId, result);
      return result;
    }

    const afterSnapshot = await snapshotOtherTabs(localPath, excludeFromIntegrityCheck);
    if (!afterSnapshot.ok) {
      const result = driveWarningResult(`Could not verify other tabs after editing: ${afterSnapshot.reason}`);
      completeLateralPostedRun(runId, result);
      return result;
    }
    const unexpected = findUnexpectedTabChanges(beforeSnapshot.hashes, afterSnapshot.hashes);
    if (unexpected.length > 0) {
      const result = driveWarningResult(`Internal safety check failed: unexpected changes on ${unexpected.join(", ")} — nothing was uploaded to Drive.`);
      completeLateralPostedRun(runId, result);
      return result;
    }

    let latestMeta: PostedWorkbookMeta;
    try {
      latestMeta = await fetchPostedWorkbookMeta(drive, fileId);
    } catch (error) {
      const result = driveWarningResult(`Could not re-check the Drive file before uploading: ${error instanceof Error ? error.message : String(error)}`);
      completeLateralPostedRun(runId, result);
      return result;
    }
    const modifiedTimeChanged = meta.modifiedTime !== null && latestMeta.modifiedTime !== null && meta.modifiedTime !== latestMeta.modifiedTime;
    const revisionChanged = meta.headRevisionId !== null && latestMeta.headRevisionId !== null && meta.headRevisionId !== latestMeta.headRevisionId;
    if (modifiedTimeChanged || revisionChanged) {
      const result = driveWarningResult("Someone else edited the workbook while this was running — nothing was uploaded to Drive.");
      completeLateralPostedRun(runId, result);
      return result;
    }

    const uploadStartedAt = logPostedStepStart("lateral", "Drive upload");
    try {
      await withPostedDriveRetry(() => uploadPostedWorkbookInPlace(drive, fileId, localPath as string), "Drive upload");
    } catch (error) {
      logPostedStepEnd("lateral", "Drive upload (failed)", uploadStartedAt);
      const result = driveWarningResult(`Drive upload failed: ${error instanceof Error ? error.message : String(error)}`);
      completeLateralPostedRun(runId, result);
      return result;
    }
    logPostedStepEnd("lateral", "Drive upload", uploadStartedAt);

    await writeLateralPostedSummary({
      ranAt: new Date().toISOString(),
      yes,
      notPosted,
      titleLinesRemoved: counts.titleLinesRemoved,
      blankRowsRemoved: counts.blankRowsRemoved,
      needsLook: counts.needsLook,
      triggeredBy: "manual",
      previewOnly: false,
    });

    const result: LateralPostedRunResult = {
      ok: true,
      busy: false,
      previewOnly: false,
      counts,
      wouldSkipDriveUpload: false,
      message: `Posted updated: ${buildSummaryText(counts)}.`,
    };
    completeLateralPostedRun(runId, result);
    return result;
  } catch (error) {
    const result = postgresAlreadyUpdated
      ? driveWarningResult(error instanceof Error ? error.message : "Unexpected error after Postgres was updated.")
      : error instanceof LateralMasterDiscoveryError
        ? nothingChangedResult(error.message)
        : nothingChangedResult(error instanceof Error ? error.message : "Posted run failed unexpectedly.");
    completeLateralPostedRun(runId, result);
    return result;
  } finally {
    await cleanupLocal(localPath);
    await lock.release();
  }
}

/** Synchronous, full-completion call — used directly by tests. Production routes use the detached starter below. */
export async function runLateralPostedButton(options?: LateralPostedRunOptions): Promise<LateralPostedRunResult> {
  const lock = await acquireLateralJobLock();
  if (!lock.acquired) {
    return { ok: false, busy: true, message: resolveLateralBusyMessage(lock.message) };
  }
  const runId = crypto.randomUUID();
  beginLateralPostedRun(runId);
  return executeLateralPostedWork(lock, runId, options);
}

/**
 * Fire-and-forget starter for the API route — returns as soon as the lock
 * decision is known, never holds the HTTP connection for the run's
 * duration. Mirrors `startLateralJobAsync` exactly.
 */
export async function startLateralPostedRunDetached(
  options?: LateralPostedRunOptions
): Promise<{ started: true; runId: string } | { started: false; message: string }> {
  const lock = await acquireLateralJobLock();
  if (!lock.acquired) {
    return { started: false, message: resolveLateralBusyMessage(lock.message) };
  }
  const runId = crypto.randomUUID();
  beginLateralPostedRun(runId);
  void executeLateralPostedWork(lock, runId, options).catch((error) => {
    // executeLateralPostedWork's own catch already completes the run and
    // releases the lock — this only guards against something throwing
    // past that, so the run is never left silently "active" forever.
    completeLateralPostedRun(runId, driveWarningResult(error instanceof Error ? error.message : "Unexpected error."));
  });
  return { started: true, runId };
}

export function getLateralPostedRunStatus() {
  return getLateralPostedSnapshot<LateralPostedRunResult>();
}
