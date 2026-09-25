/**
 * Read-only query layer for `candidate_sync_history` (migration 016) and for
 * resolving "which CIDs did sync N touch" — the data behind the Candidate
 * Master Sheet's "filter by sync" control.
 *
 * A sync's full row set is the union of THREE sources, not one:
 *  - candidate_master.inserted_sync_id = N (rows that sync N inserted;
 *    migration 019 — candidate_sync_changes never logs inserts, only
 *    field-level updates, so this column is the only record of them)
 *  - candidate_sync_changes.sync_id = N (rows updated by sync N)
 *  - candidate_review_flags.sync_id = N (rows flagged for review by sync N)
 * getCandidateCidsTouchedBySync only covers the latter two (update/flag);
 * the caller combines it with candidate_master.inserted_sync_id itself,
 * since that's already present on every row the page-serving layer loads.
 *
 * No `import "server-only"` — same reasoning as the other read-* modules in
 * this directory: importable by standalone tsx verify scripts.
 */
import { getDbClient } from "@/lib/persistence/db-client";
import type postgres from "postgres";

export type SqlClient = ReturnType<typeof postgres>;

export interface CandidateSyncHistoryRow {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  result: "success" | "partial" | "failed";
  sourceFilename: string | null;
  triggeredBy: string | null;
  counts: {
    rowsInSheet: number;
    inserted: number;
    updated: number;
    unchanged: number;
    quarantined: number;
    reviewFlags: number;
  };
}

/** Most recent syncs first, for a "filter by sync" picker. Excludes the one-time legacy migration row (no real "rows this sync touched" concept for it — it seeded the whole table). */
export async function listRecentCandidateSyncHistory(
  limit = 25,
  sqlClient?: SqlClient
): Promise<CandidateSyncHistoryRow[]> {
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<
    {
      id: number | string;
      started_at: string;
      finished_at: string | null;
      result: string;
      source_filename: string | null;
      triggered_by: string | null;
      rows_in_sheet: number;
      inserted_count: number;
      updated_count: number;
      unchanged_count: number;
      quarantined_count: number;
      review_flag_count: number;
    }[]
  >`
    SELECT
      id, started_at, finished_at, result, source_filename, triggered_by,
      rows_in_sheet, inserted_count, updated_count, unchanged_count,
      quarantined_count, review_flag_count
    FROM candidate_sync_history
    WHERE source_filename IS DISTINCT FROM 'legacy-schema-migration-oorwin'
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    id: Number(row.id),
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    result: row.result as CandidateSyncHistoryRow["result"],
    sourceFilename: row.source_filename,
    triggeredBy: row.triggered_by,
    counts: {
      rowsInSheet: row.rows_in_sheet,
      inserted: row.inserted_count,
      updated: row.updated_count,
      unchanged: row.unchanged_count,
      quarantined: row.quarantined_count,
      reviewFlags: row.review_flag_count,
    },
  }));
}

/** CIDs updated or flagged by sync `syncId` (see the file-level comment for why inserts aren't included here). */
export async function getCandidateCidsTouchedBySync(
  syncId: number,
  sqlClient?: SqlClient
): Promise<Set<string>> {
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<{ cid: string }[]>`
    SELECT cid FROM candidate_sync_changes WHERE sync_id = ${syncId}
    UNION
    SELECT cid FROM candidate_review_flags WHERE sync_id = ${syncId}
  `;
  return new Set(rows.map((row) => row.cid));
}
