/**
 * Read-only query layer for the Candidate Master Sheet's Accenture Final
 * Report highlighting (Stage 3) — violet cells, hover data, and the
 * filter-support lookups ("New Rows" / "Latest Upload").
 *
 * Deliberately standalone: never imports from, or shares logic with,
 * read-candidate-highlights.ts. Per the explicit Stage 3 decision, Oorwin's
 * own "Recently changed" window (emerald) stays completely untouched and
 * Oorwin-only; the violet window below is a fully independent computation
 * that happens to read the same two underlying tables
 * (candidate_sync_changes / candidate_review_flags are NOT used here at
 * all, only candidate_sync_changes / candidate_sync_history / candidate_master).
 *
 * "Latest successful" Accenture run: `result IN ('success', 'partial')` —
 * confirmed against the real CHECK constraint on candidate_sync_history.result
 * (migration 016: `CHECK (result IN ('success', 'partial', 'failed'))`) —
 * those are the only two non-'failed' values that exist, so this is exactly
 * "not failed," matching the Stage 3 brief's own phrasing. A failed run's
 * whole transaction is rolled back by Stage 2's job wrapper anyway (it can
 * never have actually written any of the rows this module reads), so this
 * filter is a belt-and-suspenders guard, not the only thing protecting
 * against a failed run polluting the highlight state.
 *
 * ORDER BY `changed_at DESC, id DESC` (changed from a plain `id DESC`) when
 * finding the single most recent candidate_sync_changes row for a
 * (cid, field_name) pair. The classic engine's own rows never backdate
 * `changed_at` — within its one `sql.begin()` transaction, Postgres's
 * `now()` (the column's DEFAULT) is stable for the whole transaction, so
 * every row that ONE run writes shares an identical `changed_at`, and
 * `id DESC` alone used to be the only reliable signal for those rows
 * (confirmed empirically, scripts/verify-candidate-accenture-highlights.ts).
 * That stopped being sufficient once the Accenture REPLAY engine
 * (candidate-accenture-replay-engine.ts, dated Master Sheet uploads)
 * started backdating most steps' `changed_at` to their true file report
 * date — a row inserted today with an old `changed_at` still gets a
 * higher `id` than anything from a genuinely older run, so `id DESC`
 * alone would wrongly rank a backdated historical step as "latest" over
 * a real, more recent Oorwin/manual edit (the frozen-field case).
 *
 * This is only safe BECAUSE the replay engine stamps exactly one step per
 * (cid, field_name) per run — whichever one actually writes the live
 * `candidate_master` column — with REAL time instead of its backdated
 * date (see that module's "LATEST-WRITER ORDERING" doc comment). That
 * makes `changed_at DESC, id DESC` correct in both directions: a frozen
 * field's Accenture steps all stay backdated (none of them wrote live),
 * so a later real edit's genuinely later `changed_at` correctly wins; and
 * when Accenture DOES overwrite a field after an earlier real edit (the
 * "inversion" case), the one step that performed that write carries
 * today's real timestamp, correctly outranking that earlier edit.
 */
import { getDbClient } from "@/lib/persistence/db-client";
import type postgres from "postgres";

export type SqlClient = ReturnType<typeof postgres>;

/** The 5 fields the Accenture engine actually writes, plus 'name' for its never-applied mismatch note. */
const ACCENTURE_HOVER_FIELDS = [
  "email",
  "job_management_level",
  "accenture_candidate_stage",
  "current_cid_source",
  "application_completion_status",
  "name",
] as const;

export interface AccentureLatestRun {
  id: number;
  startedAt: string;
  sourceFilename: string | null;
}

/** The single latest run with kind='accenture_upload' and a non-failed result. Null if none has ever run successfully. */
export async function getLatestSuccessfulAccentureRun(
  sqlClient?: SqlClient
): Promise<AccentureLatestRun | null> {
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<
    { id: number | string; started_at: string; source_filename: string | null }[]
  >`
    SELECT id, started_at, source_filename
    FROM candidate_sync_history
    WHERE kind = 'accenture_upload' AND result IN ('success', 'partial')
    ORDER BY id DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    startedAt: new Date(row.started_at).toISOString(),
    sourceFilename: row.source_filename,
  };
}

/**
 * Every candidate_sync_history id ever stamped kind='accenture_upload' with
 * a non-failed result — backs the PERMANENT "Accenture Final Report New
 * Rows" filter (every CID ever inserted by ANY Accenture run, not just the
 * latest one; never clears once a row has been inserted this way).
 */
export async function getAccentureUploadSyncIds(sqlClient?: SqlClient): Promise<Set<number>> {
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<{ id: number | string }[]>`
    SELECT id FROM candidate_sync_history
    WHERE kind = 'accenture_upload' AND result IN ('success', 'partial')
  `;
  return new Set(rows.map((row) => Number(row.id)));
}

export type AccentureChangedFieldsByCid = Map<string, Set<string>>;

/** Cells (db column names; 'name' included when a mismatch note was written) touched by exactly ONE run — not a window, always one specific sync_id. */
export async function getAccentureChangedFieldsForRun(
  syncId: number,
  sqlClient?: SqlClient
): Promise<AccentureChangedFieldsByCid> {
  const map: AccentureChangedFieldsByCid = new Map();
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<{ cid: string; field_name: string }[]>`
    SELECT DISTINCT cid, field_name FROM candidate_sync_changes WHERE sync_id = ${syncId}
  `;
  for (const row of rows) {
    const set = map.get(row.cid) ?? new Set<string>();
    set.add(row.field_name);
    map.set(row.cid, set);
  }
  return map;
}

/** CIDs of LIVE rows inserted by this specific run. */
export async function getCidsInsertedByRun(
  syncId: number,
  sqlClient?: SqlClient
): Promise<Set<string>> {
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<{ cid: string }[]>`
    SELECT cid FROM candidate_master WHERE inserted_sync_id = ${syncId} AND deleted_at IS NULL
  `;
  return new Set(rows.map((row) => row.cid));
}

export interface CandidateAccentureHoverEntry {
  /**
   * True only when the single most recent candidate_sync_changes row for
   * this exact (cid, field_name) — any source, any sync kind, tie-broken by
   * id DESC — came from an accenture_upload run. False whenever a LATER
   * manual edit or Oorwin write (which both write their own
   * candidate_sync_changes row on a real value change) has since become
   * the new "most recent" row for this field — this is what makes the
   * hover (and, for 'name' specifically, the highlight too) revert to
   * plain automatically, with no extra staleness check needed.
   */
  isAccentureLatest: boolean;
  /** The 5 synced fields only: the value BEFORE that run touched this field — old_value of the run's EARLIEST step for this (cid, field), not the last step's. Null unless isAccentureLatest. */
  previousValue: string | null;
  /** 'name' only: the file's reported name from that run (new_value of its note). Null unless isAccentureLatest and field is 'name'. */
  fileReportedValue: string | null;
  sourceFilename: string | null;
  startedAt: string | null;
}

/** cid -> field_name (db column, or 'name') -> hover entry. */
export type CandidateAccentureHoverByCid = Map<string, Map<string, CandidateAccentureHoverEntry>>;

/**
 * Per-(cid, field) hover data for the 5 synced fields + name, scoped to the
 * given CIDs (the current page — this table is unbounded in principle, so
 * never queried for the whole dataset at once, same page-scoping
 * discipline read-candidate-highlights.ts's C9 queries already use).
 */
export async function getAccentureHoverData(
  cids: string[],
  sqlClient?: SqlClient
): Promise<CandidateAccentureHoverByCid> {
  const result: CandidateAccentureHoverByCid = new Map();
  if (cids.length === 0) return result;
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<
    {
      cid: string;
      field_name: string;
      sync_id: number | string | null;
      new_value: string | null;
      previous_value: string | null;
      kind: string | null;
      source_filename: string | null;
      started_at: string | null;
    }[]
  >`
    WITH scoped AS (
      SELECT cid, field_name, sync_id, old_value, new_value, id, changed_at
      FROM candidate_sync_changes
      WHERE cid = ANY(${cids}) AND field_name = ANY(${ACCENTURE_HOVER_FIELDS})
    ),
    ranked AS (
      SELECT
        cid, field_name, sync_id, old_value, new_value, id, changed_at,
        ROW_NUMBER() OVER (PARTITION BY cid, field_name ORDER BY changed_at DESC, id DESC) AS rn_latest,
        ROW_NUMBER() OVER (PARTITION BY cid, field_name, sync_id ORDER BY id ASC) AS rn_earliest_in_run
      FROM scoped
    )
    SELECT
      latest.cid, latest.field_name, latest.sync_id, latest.new_value,
      earliest.old_value AS previous_value,
      csh.kind, csh.source_filename, csh.started_at
    FROM ranked latest
    JOIN ranked earliest
      ON earliest.cid = latest.cid
     AND earliest.field_name = latest.field_name
     AND earliest.sync_id IS NOT DISTINCT FROM latest.sync_id
     AND earliest.rn_earliest_in_run = 1
    LEFT JOIN candidate_sync_history csh ON csh.id = latest.sync_id
    WHERE latest.rn_latest = 1
  `;

  for (const row of rows) {
    const isAccentureLatest = row.kind === "accenture_upload";
    const entry: CandidateAccentureHoverEntry = {
      isAccentureLatest,
      previousValue: isAccentureLatest && row.field_name !== "name" ? row.previous_value : null,
      fileReportedValue: isAccentureLatest && row.field_name === "name" ? row.new_value : null,
      sourceFilename: isAccentureLatest ? row.source_filename : null,
      startedAt: isAccentureLatest && row.started_at ? new Date(row.started_at).toISOString() : null,
    };
    const byField = result.get(row.cid) ?? new Map<string, CandidateAccentureHoverEntry>();
    byField.set(row.field_name, entry);
    result.set(row.cid, byField);
  }
  return result;
}
