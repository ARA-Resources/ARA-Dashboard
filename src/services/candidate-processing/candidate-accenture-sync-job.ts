/**
 * Sync orchestrator for the Candidate Master Sheet Accenture Final Report
 * upload (Stage 2).
 *
 * Unlike candidate-sync-job.ts (Oorwin, per-row commit, history row created
 * BEFORE the engine runs and survives even if the engine throws), this is a
 * single whole-file transaction: the history row is created INSIDE the same
 * `sql.begin()` as the engine run, so a mid-file failure rolls back
 * EVERYTHING (including that history row) — then, outside any transaction,
 * exactly one fresh 'failed' history row is written with the error message,
 * per the spec's explicit rollback requirement.
 *
 * `dryRun: true` never opens a transaction at all (mirrors
 * scripts/lateral-master-additive-import.ts's own dry-run convention — "no
 * transaction was opened") and writes nothing anywhere, including no
 * history row — it is a pure preview.
 *
 * Every `candidate_sync_history` row this module creates is stamped
 * `kind = 'accenture_upload'` (plain TEXT column, migration 021 — no CHECK
 * constraint to alter for this new value, per migration 022's own comment).
 */
import type postgres from "postgres";
import { getDbClient } from "@/lib/persistence/db-client";
import { parseCandidateAccentureWorkbook } from "./candidate-accenture-parser";
import {
  runCandidateAccentureSync,
  type CandidateAccentureSyncSummary,
} from "./candidate-accenture-engine";
import {
  runCandidateAccentureReplaySync,
  type CandidateAccentureReplaySyncSummary,
} from "./candidate-accenture-replay-engine";

/**
 * The top-level client only (needs `.begin`) — this module always opens its
 * own transaction (or, for dryRun, uses the top-level client directly for
 * read-only queries), never accepts an already-open `tx` handle. Same
 * pattern/reasoning as candidate-manual-edit.ts's own `TopLevelSqlClient`.
 */
type TopLevelSqlClient = ReturnType<typeof postgres>;

export type CandidateAccentureSyncRunResultStatus = "success" | "partial" | "failed";

export interface CandidateAccentureSyncRunResult {
  result: CandidateAccentureSyncRunResultStatus;
  dryRun: boolean;
  syncId: number | null;
  startedAt: string;
  finishedAt: string;
  sourceFilename: string;
  triggeredBy: string;
  /** Classic single-snapshot shape, or the replay-mode shape (dated Master Sheet export) — see `parsed.hasDateColumn`, which is what picked the engine that produced this. */
  counts: CandidateAccentureSyncSummary | CandidateAccentureReplaySyncSummary;
  failureReason: string | null;
}

function needsReview(summary: { invalidCidCount: number; skippedBlankCidCount: number; reviewFlagCount: number }): boolean {
  return summary.invalidCidCount > 0 || summary.skippedBlankCidCount > 0 || summary.reviewFlagCount > 0;
}

const EMPTY_SUMMARY: CandidateAccentureSyncSummary = {
  rowsInSheet: 0,
  matchedCidCount: 0,
  matchedRowCount: 0,
  insertedCount: 0,
  skippedBlankCidCount: 0,
  invalidCidCount: 0,
  reviewFlagCount: 0,
  fieldChangeCounts: {
    email: 0,
    job_management_level: 0,
    accenture_candidate_stage: 0,
    current_cid_source: 0,
    application_completion_status: 0,
  },
  levelFormatOnlyNoOpCount: 0,
  nameMismatchNotesCount: 0,
  blankCellsKeptCount: 0,
  newlyLockedCount: { email: 0, job_management_level: 0 },
};

export async function invokeCandidateAccentureSync(
  fileBuffer: Buffer,
  filename: string,
  triggeredBy: string,
  sqlClient?: TopLevelSqlClient,
  dryRun = false
): Promise<CandidateAccentureSyncRunResult> {
  const sql = sqlClient ?? getDbClient();
  const startedAt = new Date();

  const parsed = parseCandidateAccentureWorkbook(fileBuffer);
  if (!parsed.ok) {
    if (dryRun) {
      return {
        result: "failed",
        dryRun: true,
        syncId: null,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        sourceFilename: filename,
        triggeredBy,
        counts: EMPTY_SUMMARY,
        failureReason: parsed.message,
      };
    }
    const [historyRow] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history
        (started_at, finished_at, result, source_filename, triggered_by, failure_reason, kind)
      VALUES (${startedAt}, NOW(), 'failed', ${filename}, ${triggeredBy}, ${parsed.message}, 'accenture_upload')
      RETURNING id
    `;
    return {
      result: "failed",
      dryRun: false,
      syncId: Number(historyRow.id),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      sourceFilename: filename,
      triggeredBy,
      counts: EMPTY_SUMMARY,
      failureReason: parsed.message,
    };
  }

  if (dryRun) {
    const summary = parsed.hasDateColumn
      ? await runCandidateAccentureReplaySync(parsed.rows, null, sql, { dryRun: true })
      : await runCandidateAccentureSync(parsed.rows, null, sql, { dryRun: true });
    const finishedAt = new Date();
    return {
      result: needsReview(summary) ? "partial" : "success",
      dryRun: true,
      syncId: null,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      sourceFilename: filename,
      triggeredBy,
      counts: summary,
      failureReason: null,
    };
  }

  try {
    const { summary, syncId, result } = await sql.begin(async (tx) => {
      const [historyRow] = await tx<{ id: number }[]>`
        INSERT INTO candidate_sync_history
          (started_at, result, source_filename, triggered_by, rows_in_sheet, kind)
        VALUES (${startedAt}, 'success', ${filename}, ${triggeredBy}, ${parsed.rows.length}, 'accenture_upload')
        RETURNING id
      `;
      const txSyncId = Number(historyRow.id);
      const txSummary = parsed.hasDateColumn
        ? await runCandidateAccentureReplaySync(parsed.rows, txSyncId, tx, { dryRun: false })
        : await runCandidateAccentureSync(parsed.rows, txSyncId, tx, { dryRun: false });
      const txResult: CandidateAccentureSyncRunResultStatus = needsReview(txSummary) ? "partial" : "success";

      await tx`
        UPDATE candidate_sync_history SET
          finished_at = NOW(),
          result = ${txResult},
          inserted_count = ${txSummary.insertedCount},
          updated_count = ${txSummary.matchedRowCount},
          review_flag_count = ${txSummary.reviewFlagCount}
        WHERE id = ${txSyncId}
      `;

      return { summary: txSummary, syncId: txSyncId, result: txResult };
    });

    return {
      result,
      dryRun: false,
      syncId,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      sourceFilename: filename,
      triggeredBy,
      counts: summary,
      failureReason: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const finishedAt = new Date();
    const [historyRow] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history
        (started_at, finished_at, result, source_filename, triggered_by, failure_reason, kind)
      VALUES (${startedAt}, ${finishedAt}, 'failed', ${filename}, ${triggeredBy}, ${message}, 'accenture_upload')
      RETURNING id
    `;
    return {
      result: "failed",
      dryRun: false,
      syncId: Number(historyRow.id),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      sourceFilename: filename,
      triggeredBy,
      counts: EMPTY_SUMMARY,
      failureReason: message,
    };
  }
}
