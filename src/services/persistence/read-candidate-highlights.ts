/**
 * Read-only query layer for the Candidate Master Sheet's C9 highlighting —
 * "changed in the most recent sync" (green) and "open review flag"
 * (row/amber) state — and C10's full per-candidate change history, all
 * sourced from `candidate_sync_changes` / `candidate_review_flags`
 * (migrations 016/017).
 *
 * No `import "server-only"` — same reasoning as read-candidate-master.ts:
 * meant to be importable by both the page-serving Postgres layer and
 * standalone tsx verify scripts, neither of which run inside Next's
 * bundler for the latter.
 *
 * The two "latest" queries implement the "latest per issue" rule documented
 * in candidate-sync-engine.ts's top-of-file comment and migration 017's
 * comment: MAX(sync_id) per grouping key, joined back for every row
 * matching that exact key — never a naive DISTINCT ON, which would
 * silently collapse a CID with more than one simultaneous change/flag
 * sharing the same grouping key down to a single row. `sync_id` is
 * nullable in the schema, so the join uses `IS NOT DISTINCT FROM` rather
 * than `=` to still match correctly if it's ever NULL. C10's history query
 * is deliberately the opposite: no "latest" filter at all — every row ever
 * written for that CID, across every sync, in chronological order.
 */
import { getDbClient } from "@/lib/persistence/db-client";
import type postgres from "postgres";
import {
  excelHeaderForCandidateDbColumn,
  type CandidateMasterExcelHeader,
  type CandidateMasterSheetDbColumn,
} from "@/services/persistence/candidate-master-sheet-columns";

export type SqlClient = ReturnType<typeof postgres>;

/** Mirrors the CHECK constraint on candidate_review_flags.reason (migration 018). */
export type CandidateReviewFlagReason =
  | "duplicate_name_mismatch"
  | "invalid_candidate_id"
  | "jr_id_conflict"
  | "legacy_contact_number_unclean"
  | "missing_job_requisition_id"
  | "unclean_contact_number";

/** CID -> set of DB column names changed in the most recent sync that touched that CID. */
export type CandidateChangedFieldsByCid = Map<string, Set<string>>;

export interface CandidateReviewFlagRow {
  cid: string;
  reason: CandidateReviewFlagReason;
  detail: Record<string, unknown>;
  syncId: number | null;
  createdAt: string;
}

/** Latest-sync-per-CID changed field names (green highlight source). */
export async function getLatestCandidateChangedFields(
  sqlClient?: SqlClient
): Promise<CandidateChangedFieldsByCid> {
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<{ cid: string; field_name: string }[]>`
    SELECT csc.cid, csc.field_name
    FROM candidate_sync_changes csc
    JOIN (
      SELECT cid, MAX(sync_id) AS latest_sync_id
      FROM candidate_sync_changes
      GROUP BY cid
    ) latest
      ON latest.cid = csc.cid
     AND csc.sync_id IS NOT DISTINCT FROM latest.latest_sync_id
  `;
  const map: CandidateChangedFieldsByCid = new Map();
  for (const row of rows) {
    const set = map.get(row.cid) ?? new Set<string>();
    set.add(row.field_name);
    map.set(row.cid, set);
  }
  return map;
}

/** Latest-per-(cid,reason) open review flags (row/amber highlight source), full detail preserved. */
export async function getLatestCandidateReviewFlags(
  sqlClient?: SqlClient
): Promise<CandidateReviewFlagRow[]> {
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<
    {
      cid: string;
      reason: string;
      detail: unknown;
      sync_id: number | string | null;
      created_at: string;
    }[]
  >`
    SELECT crf.cid, crf.reason, crf.detail, crf.sync_id, crf.created_at
    FROM candidate_review_flags crf
    JOIN (
      SELECT cid, reason, MAX(sync_id) AS latest_sync_id
      FROM candidate_review_flags
      GROUP BY cid, reason
    ) latest
      ON latest.cid = crf.cid
     AND latest.reason = crf.reason
     AND crf.sync_id IS NOT DISTINCT FROM latest.latest_sync_id
    ORDER BY crf.cid, crf.reason, crf.id
  `;
  return rows.map((row) => ({
    cid: row.cid,
    reason: row.reason as CandidateReviewFlagReason,
    detail: (row.detail ?? {}) as Record<string, unknown>,
    syncId: row.sync_id === null ? null : Number(row.sync_id),
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

/** One historical field change for the C10 candidate history popup. */
export interface CandidateHistoryEntry {
  header: CandidateMasterExcelHeader;
  oldValue: string;
  newValue: string;
  changedAt: string;
  syncId: number;
  sourceFilename: string | null;
  triggeredBy: string | null;
}

/**
 * Full change history for one CID across every sync, oldest first — no
 * "latest sync only" filter (that's C9's job, above). Left-joined to
 * candidate_sync_history for traceability (which file / who triggered it),
 * tolerating a missing history row rather than dropping the change entry.
 */
export async function getCandidateChangeHistory(
  cid: string,
  sqlClient?: SqlClient
): Promise<CandidateHistoryEntry[]> {
  const trimmed = String(cid ?? "").trim();
  if (!trimmed || trimmed === "-") return [];
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<
    {
      field_name: string;
      old_value: string | null;
      new_value: string | null;
      changed_at: string;
      sync_id: number | string;
      source_filename: string | null;
      triggered_by: string | null;
    }[]
  >`
    SELECT
      csc.field_name,
      csc.old_value,
      csc.new_value,
      csc.changed_at,
      csc.sync_id,
      csh.source_filename,
      csh.triggered_by
    FROM candidate_sync_changes csc
    LEFT JOIN candidate_sync_history csh ON csh.id = csc.sync_id
    WHERE csc.cid = ${trimmed}
    ORDER BY csc.changed_at ASC, csc.id ASC
  `;

  const entries: CandidateHistoryEntry[] = [];
  for (const row of rows) {
    let header: CandidateMasterExcelHeader;
    try {
      header = excelHeaderForCandidateDbColumn(row.field_name as CandidateMasterSheetDbColumn);
    } catch {
      continue; // stray field_name that isn't a displayed column — skip rather than crash the popup
    }
    entries.push({
      header,
      oldValue: row.old_value ?? "-",
      newValue: row.new_value ?? "-",
      changedAt: new Date(row.changed_at).toISOString(),
      syncId: Number(row.sync_id),
      sourceFilename: row.source_filename,
      triggeredBy: row.triggered_by,
    });
  }
  return entries;
}
