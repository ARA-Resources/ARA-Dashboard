/**
 * Read-only PostgreSQL query layer for `candidate_master` (migration 012).
 *
 * Mirrors `read-executive-master.ts` in shape, but is fully standalone: does
 * not import from, or share query logic with, the lateral/executive read
 * modules. Does NOT read Excel/Drive. Does NOT write. Does NOT alter schema.
 * Access: `getDbClient()` from `@/lib/persistence/db-client`.
 *
 * No `import "server-only"` marker (unlike candidate-master-sheet-postgres.ts,
 * the page-serving module built on top of this one) — matches
 * read-lateral-master.ts / read-executive-master.ts, which are also imported
 * directly by standalone tsx scripts (verify-lateral-master-read-layer.ts
 * etc.) and by the Oorwin sync engine, neither of which run inside Next's
 * bundler where "server-only" resolves.
 *
 * Migration 021 (Candidate Master manual Add/Modify/Delete): every function
 * here is soft-delete aware — `deleted_at IS NULL` on every SELECT — so a
 * soft-deleted row is invisible to the on-screen table, the Oorwin sync
 * engine's CID matching, and every other consumer of this module without
 * each of them having to remember to filter it out themselves.
 */
import { getDbClient } from "@/lib/persistence/db-client";
import type postgres from "postgres";

/**
 * Migration 021: widened from the plain `ReturnType<typeof postgres>` every
 * other read-*.ts module in this codebase uses, specifically so this
 * module's query functions can be called with EITHER the top-level client
 * OR a `tx` handle from inside `sql.begin(async (tx) => ...)` (postgres.js
 * types these as two structurally different interfaces —
 * `postgres.TransactionSql` is missing the top-level-only members like
 * `.begin`/`.end`, so it doesn't satisfy `postgres.Sql` on its own).
 * candidate-manual-edit.ts's Add/Modify both run inside one transaction and
 * need to read the row they're editing mid-transaction.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- matches postgres.js's own default generic `{}`, kept identical to ReturnType<typeof postgres> so getDbClient() unifies without a cast.
export type SqlClient = postgres.Sql<{}> | postgres.TransactionSql<{}>;

// The SELECT column list is spelled out per-query below (not shared via
// sql.unsafe) to match the rest of this file's existing convention — every
// query in this module already repeats its own literal column list.

export interface CandidateMasterRow {
  id: number;
  cid: string;
  name: string;
  gender: string;
  contact_number: string;
  date_of_upload: string;
  submitter: string;
  customer: string;
  job_requisition_id: string;
  primary_skills: string;
  job_management_level: string;
  market: string;
  submitted_date: string;
  status: string;
  submission_comments: string;
  email: string;
  client_spoc: string;
  /** Migration 022 — business columns written by the Accenture Final Report upload (Stage 2, not built yet). */
  accenture_candidate_stage: string;
  current_cid_source: string;
  application_completion_status: string;
  /** Migration 022 — inert placeholders for a later, separate ATCI-screening-file stage. */
  screening_candidate_stage: string;
  disposition_reason: string;
  last_touched_at: string | null;
  inserted_sync_id: number | null;
  /**
   * Migration 022 — once an Accenture upload writes a new value into
   * email / job_management_level, the matching lock flips true and stays
   * true forever (not cleared by a manual edit), so a later Oorwin sync
   * must fall back to the existing value for that field instead of
   * overwriting it. System bookkeeping — deliberately NOT in
   * CANDIDATE_MASTER_SHEET_DB_COLUMNS, never exposed to Add/Modify.
   */
  email_accenture_locked: boolean;
  job_management_level_accenture_locked: boolean;
  /**
   * Migration 022 — the most recent Accenture run (matched or inserted)
   * that touched this row, set unconditionally on every touch regardless of
   * whether any value changed. System bookkeeping — same exclusions as the
   * lock fields above.
   */
  last_accenture_sync_id: number | null;
  /** Migration 023 — this CID's own last report date within the most recent Accenture run that touched it ("YYYY-MM-DD"), set unconditionally on every touch, same discipline as last_accenture_sync_id. Backstops the replay engine's per-field checkpoint for a field that had zero real steps in that run. */
  last_accenture_report_date: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

function mapRow(row: Record<string, unknown>): CandidateMasterRow {
  return {
    id: Number(row.id),
    cid: String(row.cid ?? ""),
    name: String(row.name ?? ""),
    gender: String(row.gender ?? ""),
    contact_number: String(row.contact_number ?? ""),
    date_of_upload: String(row.date_of_upload ?? ""),
    submitter: String(row.submitter ?? ""),
    customer: String(row.customer ?? ""),
    job_requisition_id: String(row.job_requisition_id ?? ""),
    primary_skills: String(row.primary_skills ?? ""),
    job_management_level: String(row.job_management_level ?? ""),
    market: String(row.market ?? ""),
    submitted_date: String(row.submitted_date ?? ""),
    status: String(row.status ?? ""),
    submission_comments: String(row.submission_comments ?? ""),
    email: String(row.email ?? "-"),
    client_spoc: String(row.client_spoc ?? "-"),
    accenture_candidate_stage: String(row.accenture_candidate_stage ?? "-"),
    current_cid_source: String(row.current_cid_source ?? "-"),
    application_completion_status: String(row.application_completion_status ?? "-"),
    screening_candidate_stage: String(row.screening_candidate_stage ?? "-"),
    disposition_reason: String(row.disposition_reason ?? "-"),
    last_touched_at:
      row.last_touched_at == null ? null : new Date(row.last_touched_at as string).toISOString(),
    inserted_sync_id: row.inserted_sync_id == null ? null : Number(row.inserted_sync_id),
    email_accenture_locked: Boolean(row.email_accenture_locked),
    job_management_level_accenture_locked: Boolean(row.job_management_level_accenture_locked),
    last_accenture_sync_id:
      row.last_accenture_sync_id == null ? null : Number(row.last_accenture_sync_id),
    last_accenture_report_date:
      row.last_accenture_report_date == null ? null : String(row.last_accenture_report_date),
    deleted_at:
      row.deleted_at == null ? null : new Date(row.deleted_at as string).toISOString(),
    deleted_by: row.deleted_by == null ? null : String(row.deleted_by),
  };
}

/** Total LIVE (non-soft-deleted) rows in `candidate_master`. */
export async function countCandidateMasterRows(
  sqlClient?: SqlClient
): Promise<number> {
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM candidate_master WHERE deleted_at IS NULL
  `;
  return Number(rows[0]?.c ?? 0);
}

/**
 * All LIVE `candidate_master` rows, most recently synced/updated first — C11
 * of the Oorwin sync plan: `last_touched_at DESC NULLS LAST` (set by a live
 * sync's insert/update per migration 015, and by a manual Add/Modify per
 * migration 021) surfaces just-touched candidates at the top without a
 * manual sort change; rows never touched keep their original import order
 * via the `id ASC` tiebreaker. Display order only — no physical reordering,
 * same pattern used elsewhere.
 *
 * This is the single read every screen path goes through (the table, total/
 * pagination counts, filter-dropdown values, Highlights filter, Filter by
 * Sync, and the filtered export all call `loadRows` in
 * candidate-master-sheet-postgres.ts, which calls this) — so the
 * `deleted_at IS NULL` filter here alone keeps a soft-deleted row out of
 * every one of them.
 */
export async function listCandidateMasterRows(
  sqlClient?: SqlClient
): Promise<CandidateMasterRow[]> {
  const sql = sqlClient ?? getDbClient();
  const dataRows = await sql<Record<string, unknown>[]>`
    SELECT
      id,
      cid,
      name,
      gender,
      contact_number,
      date_of_upload,
      submitter,
      customer,
      job_requisition_id,
      primary_skills,
      job_management_level,
      market,
      submitted_date,
      status,
      submission_comments,
      email,
      client_spoc,
      accenture_candidate_stage,
      current_cid_source,
      application_completion_status,
      screening_candidate_stage,
      disposition_reason,
      last_touched_at,
      inserted_sync_id,
      email_accenture_locked,
      job_management_level_accenture_locked,
      last_accenture_sync_id,
      last_accenture_report_date,
      deleted_at,
      deleted_by
    FROM candidate_master
    WHERE deleted_at IS NULL
    ORDER BY last_touched_at DESC NULLS LAST, id ASC
  `;
  return dataRows.map(mapRow);
}

/**
 * Single-row lookup by the real database id (migration 021 — used by
 * Modify/Delete, which select a row by checkbox, not by CID, precisely
 * because CID is not unique). LIVE rows only — a soft-deleted row looks the
 * same as a nonexistent one to every caller.
 */
export async function getCandidateMasterById(
  id: number,
  sqlClient?: SqlClient
): Promise<CandidateMasterRow | null> {
  const sql = sqlClient ?? getDbClient();
  const dataRows = await sql<Record<string, unknown>[]>`
    SELECT
      id,
      cid,
      name,
      gender,
      contact_number,
      date_of_upload,
      submitter,
      customer,
      job_requisition_id,
      primary_skills,
      job_management_level,
      market,
      submitted_date,
      status,
      submission_comments,
      email,
      client_spoc,
      accenture_candidate_stage,
      current_cid_source,
      application_completion_status,
      screening_candidate_stage,
      disposition_reason,
      last_touched_at,
      inserted_sync_id,
      email_accenture_locked,
      job_management_level_accenture_locked,
      last_accenture_sync_id,
      last_accenture_report_date,
      deleted_at,
      deleted_by
    FROM candidate_master
    WHERE id = ${id} AND deleted_at IS NULL
  `;
  return dataRows[0] ? mapRow(dataRows[0]) : null;
}

/**
 * Every LIVE row whose CID is in the given list, oldest first within each
 * CID — the batched counterpart to `getCandidateMasterRowsByCid` below, for
 * a caller (the Accenture replay engine) that needs every matched row for a
 * whole file's CID set up front in ONE round trip instead of one per CID.
 * Empty input returns `[]` without a query.
 */
export async function getCandidateMasterRowsByCids(
  cids: string[],
  sqlClient?: SqlClient
): Promise<CandidateMasterRow[]> {
  const trimmed = Array.from(new Set(cids.map((c) => String(c ?? "").trim()))).filter(
    (c) => c !== "" && c !== "-"
  );
  if (trimmed.length === 0) return [];
  const sql = sqlClient ?? getDbClient();
  const dataRows = await sql<Record<string, unknown>[]>`
    SELECT
      id,
      cid,
      name,
      gender,
      contact_number,
      date_of_upload,
      submitter,
      customer,
      job_requisition_id,
      primary_skills,
      job_management_level,
      market,
      submitted_date,
      status,
      submission_comments,
      email,
      client_spoc,
      accenture_candidate_stage,
      current_cid_source,
      application_completion_status,
      screening_candidate_stage,
      disposition_reason,
      last_touched_at,
      inserted_sync_id,
      email_accenture_locked,
      job_management_level_accenture_locked,
      last_accenture_sync_id,
      last_accenture_report_date,
      deleted_at,
      deleted_by
    FROM candidate_master
    WHERE cid = ANY(${trimmed}) AND deleted_at IS NULL
    ORDER BY cid ASC, id ASC
  `;
  return dataRows.map(mapRow);
}

/**
 * Every LIVE row sharing one Candidate ID, oldest first. Migration 021: with
 * 205 CIDs already duplicated in prod, "at most one row per CID" is no
 * longer a safe assumption anywhere — this is the plural, non-throwing
 * replacement callers (the Oorwin sync engine, the manual Add duplicate
 * check) should use instead of assuming/asserting uniqueness.
 */
export async function getCandidateMasterRowsByCid(
  cid: string,
  sqlClient?: SqlClient
): Promise<CandidateMasterRow[]> {
  const trimmed = String(cid ?? "").trim();
  if (!trimmed || trimmed === "-") return [];
  const sql = sqlClient ?? getDbClient();
  const dataRows = await sql<Record<string, unknown>[]>`
    SELECT
      id,
      cid,
      name,
      gender,
      contact_number,
      date_of_upload,
      submitter,
      customer,
      job_requisition_id,
      primary_skills,
      job_management_level,
      market,
      submitted_date,
      status,
      submission_comments,
      email,
      client_spoc,
      accenture_candidate_stage,
      current_cid_source,
      application_completion_status,
      screening_candidate_stage,
      disposition_reason,
      last_touched_at,
      inserted_sync_id,
      email_accenture_locked,
      job_management_level_accenture_locked,
      last_accenture_sync_id,
      last_accenture_report_date,
      deleted_at,
      deleted_by
    FROM candidate_master
    WHERE cid = ${trimmed} AND deleted_at IS NULL
    ORDER BY id ASC
  `;
  return dataRows.map(mapRow);
}

/**
 * Single-row lookup by Candidate ID (case-sensitive exact match — CID
 * values are opaque IDs, not free text). LIVE rows only.
 *
 * Returns `null` both when no live row matches AND when more than one live
 * row matches (ambiguous) — migration 021 intentionally replaced the old
 * "throw on 2+ matches" behavior (which took down an entire Oorwin sync run
 * partway through, see candidate-sync-engine.ts) with a non-throwing
 * signal; a caller that needs to actually resolve the ambiguous case (the
 * sync engine's CID+JR-ID narrowing) uses `getCandidateMasterRowsByCid`
 * instead of this function.
 */
export async function getCandidateMasterByCid(
  cid: string,
  sqlClient?: SqlClient
): Promise<CandidateMasterRow | null> {
  const rows = await getCandidateMasterRowsByCid(cid, sqlClient);
  return rows.length === 1 ? rows[0] : null;
}
