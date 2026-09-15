/**
 * Read-only PostgreSQL query layer for `candidate_master` (migration 012).
 *
 * Mirrors `read-executive-master.ts` in shape, but is fully standalone: does
 * not import from, or share query logic with, the lateral/executive read
 * modules. Does NOT read Excel/Drive. Does NOT write. Does NOT alter schema.
 * Access: `getDbClient()` from `@/lib/persistence/db-client`.
 */
import "server-only";

import { getDbClient } from "@/lib/persistence/db-client";
import type postgres from "postgres";

export type SqlClient = ReturnType<typeof postgres>;

export interface CandidateMasterRow {
  id: number;
  cid: string;
  name: string;
  diversity: string;
  contact_number: string;
  date_of_upload: string;
  recruiter: string;
  atci_vertical: string;
  job_requisition_id: string;
  role_name_primary_skill: string;
  management_level: string;
  market: string;
  submitted_date_tracker: string;
  status_recruiter: string;
  remarks_status: string;
}

function mapRow(row: Record<string, unknown>): CandidateMasterRow {
  return {
    id: Number(row.id),
    cid: String(row.cid ?? ""),
    name: String(row.name ?? ""),
    diversity: String(row.diversity ?? ""),
    contact_number: String(row.contact_number ?? ""),
    date_of_upload: String(row.date_of_upload ?? ""),
    recruiter: String(row.recruiter ?? ""),
    atci_vertical: String(row.atci_vertical ?? ""),
    job_requisition_id: String(row.job_requisition_id ?? ""),
    role_name_primary_skill: String(row.role_name_primary_skill ?? ""),
    management_level: String(row.management_level ?? ""),
    market: String(row.market ?? ""),
    submitted_date_tracker: String(row.submitted_date_tracker ?? ""),
    status_recruiter: String(row.status_recruiter ?? ""),
    remarks_status: String(row.remarks_status ?? ""),
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

/** All `candidate_master` rows, ordered by `id` (= original source row order). */
export async function listCandidateMasterRows(
  sqlClient?: SqlClient
): Promise<CandidateMasterRow[]> {
  const sql = sqlClient ?? getDbClient();
  const dataRows = await sql<Record<string, unknown>[]>`
    SELECT
      id,
      cid,
      name,
      diversity,
      contact_number,
      date_of_upload,
      recruiter,
      atci_vertical,
      job_requisition_id,
      role_name_primary_skill,
      management_level,
      market,
      submitted_date_tracker,
      status_recruiter,
      remarks_status
    FROM candidate_master
    ORDER BY id ASC
  `;
  return dataRows.map(mapRow);
}
