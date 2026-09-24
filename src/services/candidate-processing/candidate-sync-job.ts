/**
 * Sync orchestrator for the Candidate Master Sheet Oorwin sync feature.
 *
 * Wires: parse the uploaded file (candidate-oorwin-parser.ts) → create a
 * candidate_sync_history row → run the compare/update engine
 * (candidate-sync-engine.ts) → finalize that history row with the outcome
 * → return a result-summary object, mirroring the
 * result/counts/failureReason shape Lateral/Executive's own run-summary
 * types already use (`ExecutiveRunLastSummary`), sized down for this
 * feature's simpler synchronous single-request flow (no Gmail metadata,
 * no multi-stage progress — a file upload is one request/response, same
 * scope note as Executive's own Dataset Manager page for its Run button).
 *
 * `result` is 'partial' (not 'success') whenever ANYTHING needs human
 * review after this run: quarantined duplicate-name-mismatch rows, any
 * review flag (JR conflict / unclean mobile), or any row skipped for
 * having no usable CID at all.
 *
 * Failure handling: if parsing itself fails, a 'failed' history row is
 * still recorded (for audit/visibility) with zero counts. If the compare
 * engine throws partway through the sheet (an unexpected error, not an
 * expected quarantine/conflict path), whatever it already wrote up to that
 * point stays committed — each row's DB work commits independently, not as
 * one whole-sheet transaction, matching this feature's "partial-batch"
 * philosophy — and the run is still reported honestly as 'failed' with the
 * error message, not silently as 'success'. Unlike Lateral's Gmail-sync
 * "skip this item and continue" resilience, an unexpected per-row error
 * here stops the rest of the sheet rather than skipping just that row;
 * flagging this as a possible future hardening, not implemented now.
 */
import { getDbClient } from "@/lib/persistence/db-client";
import type { SqlClient } from "@/services/persistence/read-candidate-master";
import { parseCandidateOorwinWorkbook } from "./candidate-oorwin-parser";
import { runCandidateSync, type CandidateSyncSummary } from "./candidate-sync-engine";

export type CandidateSyncRunResultStatus = "success" | "partial" | "failed";

export interface CandidateSyncRunResult {
  result: CandidateSyncRunResultStatus;
  syncId: number | null;
  startedAt: string;
  finishedAt: string;
  sourceFilename: string;
  triggeredBy: string;
  counts: {
    rowsInSheet: number;
    inserted: number;
    updated: number;
    unchanged: number;
    quarantined: number;
    skippedBlankCid: number;
    reviewFlags: number;
  };
  failureReason: string | null;
}

const EMPTY_COUNTS: CandidateSyncRunResult["counts"] = {
  rowsInSheet: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  quarantined: 0,
  skippedBlankCid: 0,
  reviewFlags: 0,
};

function toCounts(summary: CandidateSyncSummary): CandidateSyncRunResult["counts"] {
  return {
    rowsInSheet: summary.rowsInSheet,
    inserted: summary.insertedCount,
    updated: summary.updatedCount,
    unchanged: summary.unchangedCount,
    quarantined: summary.quarantinedCount,
    skippedBlankCid: summary.skippedBlankCidCount,
    reviewFlags: summary.reviewFlagCount,
  };
}

function needsReview(summary: CandidateSyncSummary): boolean {
  return summary.quarantinedCount > 0 || summary.reviewFlagCount > 0 || summary.skippedBlankCidCount > 0;
}

export async function invokeCandidateSync(
  fileBuffer: Buffer,
  filename: string,
  triggeredBy: string,
  sqlClient?: SqlClient
): Promise<CandidateSyncRunResult> {
  const sql = sqlClient ?? getDbClient();
  const startedAt = new Date();

  const parsed = parseCandidateOorwinWorkbook(fileBuffer);
  if (!parsed.ok) {
    const [historyRow] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history
        (started_at, finished_at, result, source_filename, triggered_by, failure_reason)
      VALUES (${startedAt}, NOW(), 'failed', ${filename}, ${triggeredBy}, ${parsed.message})
      RETURNING id
    `;
    return {
      result: "failed",
      // candidate_sync_history.id is BIGSERIAL; postgres.js returns bigint
      // columns as strings by default (see read-candidate-master.ts's
      // Number(row.id) precedent) — cast so callers get a real number.
      syncId: Number(historyRow.id),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      sourceFilename: filename,
      triggeredBy,
      counts: EMPTY_COUNTS,
      failureReason: parsed.message,
    };
  }

  const [historyRow] = await sql<{ id: number }[]>`
    INSERT INTO candidate_sync_history
      (started_at, result, source_filename, triggered_by, rows_in_sheet)
    VALUES (${startedAt}, 'success', ${filename}, ${triggeredBy}, ${parsed.rows.length})
    RETURNING id
  `;
  const syncId = Number(historyRow.id);

  try {
    const summary = await runCandidateSync(parsed.rows, syncId, sql);
    const result: CandidateSyncRunResultStatus = needsReview(summary) ? "partial" : "success";
    const finishedAt = new Date();

    await sql`
      UPDATE candidate_sync_history SET
        finished_at = ${finishedAt},
        result = ${result},
        inserted_count = ${summary.insertedCount},
        updated_count = ${summary.updatedCount},
        unchanged_count = ${summary.unchangedCount},
        quarantined_count = ${summary.quarantinedCount},
        review_flag_count = ${summary.reviewFlagCount}
      WHERE id = ${syncId}
    `;

    return {
      result,
      syncId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      sourceFilename: filename,
      triggeredBy,
      counts: toCounts(summary),
      failureReason: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const finishedAt = new Date();
    await sql`
      UPDATE candidate_sync_history SET
        finished_at = ${finishedAt}, result = 'failed', failure_reason = ${message}
      WHERE id = ${syncId}
    `;
    return {
      result: "failed",
      syncId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      sourceFilename: filename,
      triggeredBy,
      counts: EMPTY_COUNTS,
      failureReason: message,
    };
  }
}
