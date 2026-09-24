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
 */
import { getDbClient } from "@/lib/persistence/db-client";
import type postgres from "postgres";

export type SqlClient = ReturnType<typeof postgres>;

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
  last_touched_at: string | null;
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
    last_touched_at:
      row.last_touched_at == null ? null : new Date(row.last_touched_at as string).toISOString(),
  };
}

/** Total rows in `candidate_master`. */
export async function countCandidateMasterRows(
  sqlClient?: SqlClient
): Promise<number> {
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM candidate_master
  `;
  return Number(rows[0]?.c ?? 0);
}

/**
 * All `candidate_master` rows, most recently synced/updated first — C11 of
 * the Oorwin sync plan: `last_touched_at DESC NULLS LAST` (set only by a
 * live sync's insert/update, per migration 015) surfaces just-synced
 * candidates at the top without a manual sort change; rows never touched by
 * a live sync (every pre-Oorwin legacy row, and any untouched real row)
 * keep their original import order via the `id ASC` tiebreaker. Display
 * order only — no physical reordering, same pattern used elsewhere.
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
      last_touched_at
    FROM candidate_master
    ORDER BY last_touched_at DESC NULLS LAST, id ASC
  `;
  return dataRows.map(mapRow);
}

/**
 * Single-row lookup by Candidate ID (case-sensitive exact match — CID
 * values are opaque IDs, not free text). Returns null if not found, or if
 * more than one row matches (should be impossible after the one-time
 * legacy migration's dedupe pass collapsed same-name duplicates and
 * quarantined mismatched ones — a defensive check, not an expected path).
 */
export async function getCandidateMasterByCid(
  cid: string,
  sqlClient?: SqlClient
): Promise<CandidateMasterRow | null> {
  const trimmed = String(cid ?? "").trim();
  if (!trimmed || trimmed === "-") return null;
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
      last_touched_at
    FROM candidate_master
    WHERE cid = ${trimmed}
  `;
  if (dataRows.length > 1) {
    throw new Error(
      `[read-candidate-master] Multiple rows found for cid="${trimmed}" (expected at most one after legacy dedupe).`
    );
  }
  return dataRows[0] ? mapRow(dataRows[0]) : null;
}
