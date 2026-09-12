/**
 * Read-only PostgreSQL query layer for `executive_master` (migration 009).
 *
 * Mirrors `read-lateral-master.ts` (the Lateral equivalent). Powers the
 * Accenture Dashboard's Executive tab (P - Dashboard pivot) via
 * `listExecutiveMasterForPDashboard()`.
 *
 * Does NOT read Excel/Drive. Does NOT write. Does NOT alter schema.
 * Access: `getDbClient()` from `@/lib/persistence/db-client`.
 */
import { getDbClient } from "@/lib/persistence/db-client";
import type postgres from "postgres";
import type { ExecutivePDashboardInputRow } from "@/services/executive-processing/executive-p-dashboard-engine";

export type SqlClient = ReturnType<typeof postgres>;

/** Canonical business + operational columns on `executive_master`. */
export const EXECUTIVE_MASTER_READ_COLUMNS = [
  "job_requisition_id",
  "date",
  "market_map",
  "primary_skills",
  "primary_location",
  "job_management_level",
  "must_have_skills",
  "location_flex",
  "skill_categorization",
  "job_description",
  "job_status",
  "posted",
  "priority",
  "created_at",
  "updated_at",
  "last_seen_at",
] as const;

export type ExecutiveMasterReadColumn =
  (typeof EXECUTIVE_MASTER_READ_COLUMNS)[number];

export interface ExecutiveMasterRow {
  job_requisition_id: string;
  date: string | null;
  market_map: string | null;
  primary_skills: string | null;
  primary_location: string | null;
  job_management_level: string | null;
  must_have_skills: string | null;
  location_flex: string | null;
  skill_categorization: string | null;
  job_description: string | null;
  job_status: string | null;
  posted: string | null;
  priority: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  last_seen_at: Date | string | null;
}

function dateToIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return text;
}

function textOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return String(value);
}

function mapRow(row: Record<string, unknown>): ExecutiveMasterRow {
  return {
    job_requisition_id: String(row.job_requisition_id ?? ""),
    date: dateToIso(row.date),
    market_map: textOrNull(row.market_map),
    primary_skills: textOrNull(row.primary_skills),
    primary_location: textOrNull(row.primary_location),
    job_management_level: textOrNull(row.job_management_level),
    must_have_skills: textOrNull(row.must_have_skills),
    location_flex: textOrNull(row.location_flex),
    skill_categorization: textOrNull(row.skill_categorization),
    job_description: textOrNull(row.job_description),
    job_status: textOrNull(row.job_status),
    posted: textOrNull(row.posted),
    priority: textOrNull(row.priority),
    created_at: (row.created_at as Date | string) ?? new Date().toISOString(),
    updated_at: (row.updated_at as Date | string) ?? new Date().toISOString(),
    last_seen_at: (row.last_seen_at as Date | string | null) ?? null,
  };
}

/** Total rows in `executive_master`. */
export async function countExecutiveMasterRows(
  sqlClient?: SqlClient
): Promise<number> {
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM executive_master
  `;
  return Number(rows[0]?.c ?? 0);
}

/** All `executive_master` rows (business columns), ordered by JR. */
export async function listExecutiveMasterRows(
  sqlClient?: SqlClient
): Promise<ExecutiveMasterRow[]> {
  const sql = sqlClient ?? getDbClient();
  const dataRows = await sql<Record<string, unknown>[]>`
    SELECT
      job_requisition_id,
      date::text AS date,
      market_map,
      primary_skills,
      primary_location,
      job_management_level,
      must_have_skills,
      location_flex,
      skill_categorization,
      job_description,
      job_status,
      posted,
      priority,
      created_at,
      updated_at,
      last_seen_at
    FROM executive_master
    ORDER BY job_requisition_id ASC
  `;
  return dataRows.map(mapRow);
}

/**
 * Map a PG Master row to the P - Dashboard engine input shape.
 *
 * Keys use the ENGINE's expected source-header names ("Primary skills",
 * "Market", "Level", "Skill category", ...) — the same names the engine reads
 * off an XLSM row — NOT the renamed `executive_master` display headers.
 */
export function toExecutivePDashboardInputRow(
  row: ExecutiveMasterRow
): ExecutivePDashboardInputRow {
  return {
    id: row.job_requisition_id,
    "Primary skills": row.primary_skills,
    Market: row.market_map,
    "Primary Location": row.primary_location,
    Level: row.job_management_level,
    "Location Flex": row.location_flex,
    "Skill category": row.skill_categorization,
    "Job Status": row.job_status,
    Posted: row.posted,
    Priority: row.priority,
  };
}

/**
 * P - Dashboard detail rows from PostgreSQL, keyed for
 * `buildExecutivePDashboardFromRows` / `collectExecutivePDashboardFilterOptions`.
 */
export async function listExecutiveMasterForPDashboard(
  sqlClient?: SqlClient
): Promise<ExecutivePDashboardInputRow[]> {
  const rows = await listExecutiveMasterRows(sqlClient);
  return rows.map(toExecutivePDashboardInputRow);
}
