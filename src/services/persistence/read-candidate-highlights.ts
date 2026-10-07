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
 * Migration 021 ("Recently changed" fix): what counts as "recently
 * changed" used to be "this CID's own latest sync, forever" — it never
 * expired and never included inserts. It's now a bounded WINDOW of
 * `candidate_sync_history` rows: the single latest real Oorwin Upload
 * (`kind = 'oorwin_upload'`) plus every manual Add/Modify
 * (`kind IN ('manual_add','manual_modify')`) that happened after it (or,
 * if no Upload has ever run, every manual edit ever). See
 * `getCandidateRecentChangeWindowSyncIds`. The two "latest" queries below
 * both read within that window now, instead of per-CID-forever.
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

/** Mirrors the CHECK constraint on candidate_review_flags.reason (migration 020). */
export type CandidateReviewFlagReason =
  | "duplicate_cid"
  | "duplicate_name_mismatch"
  | "invalid_candidate_id"
  | "jr_id_conflict"
  | "legacy_contact_number_unclean"
  | "missing_job_requisition_id"
  | "unclean_contact_number"
  | "unclear_gender";

/** CID -> set of DB column names changed in the current "Recently changed" window that touched that CID. */
export type CandidateChangedFieldsByCid = Map<string, Set<string>>;

export interface CandidateReviewFlagRow {
  cid: string;
  reason: CandidateReviewFlagReason;
  detail: Record<string, unknown>;
  syncId: number | null;
  createdAt: string;
}

/**
 * "Recently changed" window: the single most recent real Oorwin Upload's
 * sync_id, plus every manual Add/Modify sync_id after it. When no Upload
 * has ever run, the window is every manual sync ever (there's no Upload to
 * anchor to). Returns an empty array when there's neither — nothing counts
 * as "recently changed" yet.
 */
export async function getCandidateRecentChangeWindowSyncIds(
  sqlClient?: SqlClient
): Promise<number[]> {
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<{ id: number | string }[]>`
    WITH window_start AS (
      SELECT MAX(id) AS start_id FROM candidate_sync_history WHERE kind = 'oorwin_upload'
    )
    SELECT csh.id
    FROM candidate_sync_history csh, window_start
    WHERE csh.id = window_start.start_id
       OR (
         csh.kind IN ('manual_add', 'manual_modify')
         AND (window_start.start_id IS NULL OR csh.id > window_start.start_id)
       )
  `;
  return rows.map((row) => Number(row.id));
}

/** Latest-in-window changed field names per CID (green highlight source). Empty window -> empty map. */
export async function getLatestCandidateChangedFields(
  windowSyncIds: number[],
  sqlClient?: SqlClient
): Promise<CandidateChangedFieldsByCid> {
  const map: CandidateChangedFieldsByCid = new Map();
  if (windowSyncIds.length === 0) return map;
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<{ cid: string; field_name: string }[]>`
    SELECT DISTINCT csc.cid, csc.field_name
    FROM candidate_sync_changes csc
    WHERE csc.sync_id = ANY(${windowSyncIds})
  `;
  for (const row of rows) {
    const set = map.get(row.cid) ?? new Set<string>();
    set.add(row.field_name);
    map.set(row.cid, set);
  }
  return map;
}

/**
 * CIDs of LIVE rows inserted (by Oorwin Upload or manual Add) within the
 * current "Recently changed" window. Needed alongside
 * `getLatestCandidateChangedFields` because a fresh INSERT has no
 * candidate_sync_changes rows of its own from the Oorwin engine (which only
 * logs field-level UPDATEs, by design — see candidate-sync-engine.ts) — a
 * manual Add's insert DOES also write change rows (old_value NULL per
 * field, see candidate-manual-edit.ts) and so already appears via
 * `getLatestCandidateChangedFields` too; this function is what makes an
 * Oorwin-inserted row visible under "Recently changed" as well.
 */
export async function getCandidateCidsInsertedInWindow(
  windowSyncIds: number[],
  sqlClient?: SqlClient
): Promise<Set<string>> {
  if (windowSyncIds.length === 0) return new Set();
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<{ cid: string }[]>`
    SELECT cid FROM candidate_master
    WHERE deleted_at IS NULL AND inserted_sync_id = ANY(${windowSyncIds})
  `;
  return new Set(rows.map((row) => row.cid));
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

/** Stage 3 — human label for a candidate_sync_history.kind value. */
export type CandidateHistoryKindLabel =
  | "Accenture Final Report upload"
  | "Oorwin upload"
  | "Manual edit"
  | "Legacy";

function labelForHistoryKind(kind: string | null): CandidateHistoryKindLabel {
  if (kind === "accenture_upload") return "Accenture Final Report upload";
  if (kind === "oorwin_upload") return "Oorwin upload";
  if (kind === "manual_add" || kind === "manual_modify") return "Manual edit";
  return "Legacy";
}

/** One historical field change for the C10 candidate history popup. */
export interface CandidateHistoryEntry {
  header: CandidateMasterExcelHeader;
  oldValue: string;
  newValue: string;
  changedAt: string;
  /**
   * Migration 024 — the true file report date ("YYYY-MM-DD") for a replay
   * -mode Accenture step, independent of `changedAt`. The replay engine
   * stamps exactly one step per (cid, field) per run — whichever one
   * actually writes the live column — with the real upload time instead
   * of its backdated file date, so that highlight/hover ordering stays
   * correct (see candidate-accenture-replay-engine.ts's "LATEST-WRITER
   * ORDERING" doc comment); `reportDate` is what survives that override
   * for display. Null for every classic-engine step and every
   * Oorwin/manual edit, where `changedAt` is already the right date to
   * show and no override ever happens.
   */
  reportDate: string | null;
  /**
   * `candidate_sync_history.started_at` for this entry's run — the real
   * upload/run-start time, captured before any file parsing. Unlike
   * `changedAt`, the replay engine never backdates this. Null only if the
   * LEFT JOIN finds no matching history row. Used for the "Uploaded ..."
   * line on replay-mode Accenture cards (the ones with a `reportDate`);
   * `finished_at` is deliberately not used here — it's captured after the
   * whole run completes, not when it started.
   */
  startedAt: string | null;
  syncId: number;
  sourceFilename: string | null;
  triggeredBy: string | null;
  /** Stage 3 — candidate_sync_history.kind, raw (null for a pre-migration-021/script-driven row). */
  kind: string | null;
  kindLabel: CandidateHistoryKindLabel;
  /**
   * Stage 3 — true for a field_name='name' row from an accenture_upload run
   * (the Accenture engine never writes the `name` column itself — this is
   * always a mismatch NOTE, never an applied change). The modal renders
   * these with distinct wording instead of the generic old->new display.
   */
  isAccentureNameMismatch: boolean;
}

/**
 * Full change history for one CID across every sync, newest first by
 * DISPLAYED date (the history popup's tile/list view shows `report_date`
 * when set, else `changed_at` — the ORDER BY sorts by that same effective
 * date, not raw `changed_at`, so a replay-mode step's backdated file date
 * sorts where it's actually displayed). `changed_at DESC, id DESC` remains
 * the tie-break for same-day entries: Stage 2's Accenture engine runs its
 * whole file inside ONE transaction, and Postgres's `now()` (this column's
 * DEFAULT) is stable for an entire transaction, so every
 * candidate_sync_changes row one Accenture run writes shares the identical
 * `changed_at` — without the `id DESC` tie-break, a multi-step chain
 * (C<-B<-A) could print in the wrong order. No "latest sync only" filter
 * (that's C9's job, above) — every row ever written for this CID, across
 * every sync. Left-joined to candidate_sync_history for traceability
 * (which file / who triggered it / its kind / its real `started_at`),
 * tolerating a missing history row rather than dropping the change entry.
 */
export async function getCandidateChangeHistory(
  cid: string,
  sqlClient?: SqlClient,
  candidateMasterId?: number | null
): Promise<CandidateHistoryEntry[]> {
  const trimmed = String(cid ?? "").trim();
  if (!trimmed || trimmed === "-") return [];
  const sql = sqlClient ?? getDbClient();
  type Row = {
    field_name: string;
    old_value: string | null;
    new_value: string | null;
    changed_at: string;
    report_date: string | null;
    sync_id: number | string;
    source_filename: string | null;
    triggered_by: string | null;
    kind: string | null;
    started_at: string | null;
  };
  // Row-scoped (masterId given, e.g. the clicked table row's candidate_master.id):
  // a CID can have more than one live candidate_master row (migration 021 —
  // never enforced unique), and the Accenture engines deliberately apply to
  // EVERY live row sharing a CID, each tagged with its own candidate_master_id
  // (migration 021). Without this filter, two rows sharing a CID have their
  // independent histories concatenated and look like duplicated entries.
  // candidate_master_id IS NULL rows (written before migration 021, never
  // backfilled) have no row identity at all, so they fall back to matching by
  // cid alone and are shown under every row sharing that cid — unavoidable for
  // that legacy data, not a regression.
  const rows =
    candidateMasterId != null
      ? await sql<Row[]>`
          SELECT
            csc.field_name,
            csc.old_value,
            csc.new_value,
            csc.changed_at,
            csc.report_date,
            csc.sync_id,
            csh.source_filename,
            csh.triggered_by,
            csh.kind,
            csh.started_at
          FROM candidate_sync_changes csc
          LEFT JOIN candidate_sync_history csh ON csh.id = csc.sync_id
          WHERE csc.cid = ${trimmed}
            AND (csc.candidate_master_id = ${candidateMasterId} OR csc.candidate_master_id IS NULL)
          ORDER BY
            COALESCE(
              CASE WHEN csc.report_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN csc.report_date::date END,
              (csc.changed_at AT TIME ZONE 'Asia/Kolkata')::date
            ) DESC,
            csc.changed_at DESC,
            csc.id DESC
        `
      : await sql<Row[]>`
          SELECT
            csc.field_name,
            csc.old_value,
            csc.new_value,
            csc.changed_at,
            csc.report_date,
            csc.sync_id,
            csh.source_filename,
            csh.triggered_by,
            csh.kind,
            csh.started_at
          FROM candidate_sync_changes csc
          LEFT JOIN candidate_sync_history csh ON csh.id = csc.sync_id
          WHERE csc.cid = ${trimmed}
          ORDER BY
            COALESCE(
              CASE WHEN csc.report_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN csc.report_date::date END,
              (csc.changed_at AT TIME ZONE 'Asia/Kolkata')::date
            ) DESC,
            csc.changed_at DESC,
            csc.id DESC
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
      reportDate: row.report_date,
      startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
      syncId: Number(row.sync_id),
      sourceFilename: row.source_filename,
      triggeredBy: row.triggered_by,
      kind: row.kind,
      kindLabel: labelForHistoryKind(row.kind),
      isAccentureNameMismatch: row.field_name === "name" && row.kind === "accenture_upload",
    });
  }
  return entries;
}
