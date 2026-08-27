/**
 * Phase 8.1 — Read-only PostgreSQL query layer for `lateral_master`.
 *
 * Source of truth: existing `lateral_master` schema (migration 003).
 * Does NOT read Excel/Drive. Does NOT write. Does NOT alter schema.
 *
 * Intended consumers (wired in later phases):
 *   8.2 P-Roles API
 *   8.3 Lateral filters / dashboard reads
 *   8.4 Home widgets (optional KPI derivation)
 *
 * Access: `getDbClient()` from `@/lib/persistence/db-client`.
 */
import { getDbClient } from "@/lib/persistence/db-client";
import type postgres from "postgres";

export type SqlClient = ReturnType<typeof postgres>;

/** Canonical business + operational columns on `lateral_master`. */
export const LATERAL_MASTER_READ_COLUMNS = [
  "job_requisition_id",
  "date",
  "priority",
  "job_description",
  "skill_categorization",
  "primary_skills",
  "job_management_level",
  "primary_location",
  "market_map",
  "poc",
  "job_status",
  "posted",
  "created_at",
  "updated_at",
  "last_seen_at",
] as const;

export type LateralMasterReadColumn =
  (typeof LATERAL_MASTER_READ_COLUMNS)[number];

/** Columns safe for ORDER BY (whitelist — never pass raw client strings to SQL). */
export const LATERAL_MASTER_SORTABLE_COLUMNS = [
  "job_requisition_id",
  "date",
  "priority",
  "skill_categorization",
  "primary_skills",
  "job_management_level",
  "primary_location",
  "market_map",
  "poc",
  "job_status",
  "posted",
  "created_at",
  "updated_at",
  "last_seen_at",
] as const;

export type LateralMasterSortColumn =
  (typeof LATERAL_MASTER_SORTABLE_COLUMNS)[number];

/** Distinct-value columns used by P-Roles / dashboard filters. */
export const LATERAL_MASTER_FILTER_VALUE_COLUMNS = [
  "job_status",
  "posted",
  "market_map",
  "priority",
  "skill_categorization",
  "primary_skills",
  "job_management_level",
  "primary_location",
  "poc",
] as const;

export type LateralMasterFilterValueColumn =
  (typeof LATERAL_MASTER_FILTER_VALUE_COLUMNS)[number];

export type LateralMasterSortDirection = "asc" | "desc";

/**
 * Multi-select filters for P-Roles dashboard.
 * Empty / omitted arrays = no constraint (same semantics as Excel P-Roles).
 * Matching is case-insensitive exact on the stored text value.
 */
export interface LateralMasterPRolesFilters {
  jobStatus?: string[];
  posted?: string[];
  marketMap?: string[];
}

export interface LateralMasterQueryFilters extends LateralMasterPRolesFilters {
  /** Optional exact JR list (case-sensitive; IDs are stored as-is). */
  jobRequisitionIds?: string[];
  priority?: string[];
  skillCategorization?: string[];
  primarySkills?: string[];
  jobManagementLevel?: string[];
  primaryLocation?: string[];
  poc?: string[];
}

export interface LateralMasterPageQuery {
  filters?: LateralMasterQueryFilters;
  page?: number;
  pageSize?: number;
  sortBy?: LateralMasterSortColumn | null;
  sortDirection?: LateralMasterSortDirection;
}

export interface LateralMasterRow {
  job_requisition_id: string;
  date: string | null;
  priority: string | null;
  job_description: string | null;
  skill_categorization: string | null;
  primary_skills: string | null;
  job_management_level: string | null;
  primary_location: string | null;
  market_map: string | null;
  poc: string | null;
  job_status: string | null;
  posted: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  last_seen_at: Date | string | null;
}

export interface LateralMasterPageResult {
  rows: LateralMasterRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  sortBy: LateralMasterSortColumn | null;
  sortDirection: LateralMasterSortDirection;
}

/** Shape expected by the existing native P-Roles engine (8.2). */
export interface LateralMasterPRolesRow {
  jobRequisitionId: string;
  primarySkills: string;
  skillCategorization: string;
  jobManagementLevel: string;
  jobStatus: string;
  posted: string;
  marketMap: string;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

const SORTABLE_SET = new Set<string>(LATERAL_MASTER_SORTABLE_COLUMNS);
const FILTER_VALUE_SET = new Set<string>(LATERAL_MASTER_FILTER_VALUE_COLUMNS);

function normalizeFilterValues(values: string[] | undefined): string[] {
  if (!values?.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
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

function mapRow(row: Record<string, unknown>): LateralMasterRow {
  return {
    job_requisition_id: String(row.job_requisition_id ?? ""),
    date: dateToIso(row.date),
    priority: typeof row.priority === "string" ? row.priority : row.priority == null ? null : String(row.priority),
    job_description:
      typeof row.job_description === "string"
        ? row.job_description
        : row.job_description == null
          ? null
          : String(row.job_description),
    skill_categorization:
      typeof row.skill_categorization === "string"
        ? row.skill_categorization
        : row.skill_categorization == null
          ? null
          : String(row.skill_categorization),
    primary_skills:
      typeof row.primary_skills === "string"
        ? row.primary_skills
        : row.primary_skills == null
          ? null
          : String(row.primary_skills),
    job_management_level:
      typeof row.job_management_level === "string"
        ? row.job_management_level
        : row.job_management_level == null
          ? null
          : String(row.job_management_level),
    primary_location:
      typeof row.primary_location === "string"
        ? row.primary_location
        : row.primary_location == null
          ? null
          : String(row.primary_location),
    market_map:
      typeof row.market_map === "string"
        ? row.market_map
        : row.market_map == null
          ? null
          : String(row.market_map),
    poc: typeof row.poc === "string" ? row.poc : row.poc == null ? null : String(row.poc),
    job_status:
      typeof row.job_status === "string"
        ? row.job_status
        : row.job_status == null
          ? null
          : String(row.job_status),
    posted:
      typeof row.posted === "string"
        ? row.posted
        : row.posted == null
          ? null
          : String(row.posted),
    created_at: (row.created_at as Date | string) ?? new Date().toISOString(),
    updated_at: (row.updated_at as Date | string) ?? new Date().toISOString(),
    last_seen_at: (row.last_seen_at as Date | string | null) ?? null,
  };
}

function resolveSort(
  sortBy: LateralMasterSortColumn | null | undefined,
  sortDirection: LateralMasterSortDirection | undefined
): { sortBy: LateralMasterSortColumn | null; sortDirection: LateralMasterSortDirection } {
  const direction = sortDirection === "asc" ? "asc" : "desc";
  if (!sortBy || !SORTABLE_SET.has(sortBy)) {
    return { sortBy: null, sortDirection: direction };
  }
  return { sortBy, sortDirection: direction };
}

function resolvePage(page: number | undefined, pageSize: number | undefined) {
  const safePage = Number.isFinite(page) && (page as number) > 0 ? Math.floor(page as number) : DEFAULT_PAGE;
  const rawSize =
    Number.isFinite(pageSize) && (pageSize as number) > 0
      ? Math.floor(pageSize as number)
      : DEFAULT_PAGE_SIZE;
  const safeSize = Math.min(Math.max(rawSize, 1), MAX_PAGE_SIZE);
  return { page: safePage, pageSize: safeSize, offset: (safePage - 1) * safeSize };
}

/**
 * Build AND fragments for multi-select filters.
 * Uses LOWER(col) = ANY(lowercased values) for case-insensitive exact match.
 */
function buildFilterFragments(
  sql: SqlClient,
  filters: LateralMasterQueryFilters | undefined
): postgres.PendingQuery<postgres.Row[]>[] {
  const fragments: postgres.PendingQuery<postgres.Row[]>[] = [];
  if (!filters) return fragments;

  const pushLowerIn = (
    column:
      | "job_status"
      | "posted"
      | "market_map"
      | "priority"
      | "skill_categorization"
      | "primary_skills"
      | "job_management_level"
      | "primary_location"
      | "poc",
    values: string[] | undefined
  ) => {
    const normalized = normalizeFilterValues(values);
    if (normalized.length === 0) return;
    // Column identifiers are whitelisted literals only.
    switch (column) {
      case "job_status":
        fragments.push(sql`LOWER(COALESCE(job_status, '')) = ANY(${normalized})`);
        break;
      case "posted":
        fragments.push(sql`LOWER(COALESCE(posted, '')) = ANY(${normalized})`);
        break;
      case "market_map":
        fragments.push(sql`LOWER(COALESCE(market_map, '')) = ANY(${normalized})`);
        break;
      case "priority":
        fragments.push(sql`LOWER(COALESCE(priority, '')) = ANY(${normalized})`);
        break;
      case "skill_categorization":
        fragments.push(
          sql`LOWER(COALESCE(skill_categorization, '')) = ANY(${normalized})`
        );
        break;
      case "primary_skills":
        fragments.push(
          sql`LOWER(COALESCE(primary_skills, '')) = ANY(${normalized})`
        );
        break;
      case "job_management_level":
        fragments.push(
          sql`LOWER(COALESCE(job_management_level, '')) = ANY(${normalized})`
        );
        break;
      case "primary_location":
        fragments.push(
          sql`LOWER(COALESCE(primary_location, '')) = ANY(${normalized})`
        );
        break;
      case "poc":
        fragments.push(sql`LOWER(COALESCE(poc, '')) = ANY(${normalized})`);
        break;
    }
  };

  pushLowerIn("job_status", filters.jobStatus);
  pushLowerIn("posted", filters.posted);
  pushLowerIn("market_map", filters.marketMap);
  pushLowerIn("priority", filters.priority);
  pushLowerIn("skill_categorization", filters.skillCategorization);
  pushLowerIn("primary_skills", filters.primarySkills);
  pushLowerIn("job_management_level", filters.jobManagementLevel);
  pushLowerIn("primary_location", filters.primaryLocation);
  pushLowerIn("poc", filters.poc);

  if (filters.jobRequisitionIds?.length) {
    const ids = [
      ...new Set(
        filters.jobRequisitionIds
          .map((id) => String(id ?? "").trim())
          .filter(Boolean)
      ),
    ];
    if (ids.length > 0) {
      fragments.push(sql`job_requisition_id = ANY(${ids})`);
    }
  }

  return fragments;
}

function whereClause(
  sql: SqlClient,
  filters: LateralMasterQueryFilters | undefined
) {
  const fragments = buildFilterFragments(sql, filters);
  if (fragments.length === 0) return sql``;
  let clause = sql`WHERE ${fragments[0]}`;
  for (let i = 1; i < fragments.length; i += 1) {
    clause = sql`${clause} AND ${fragments[i]}`;
  }
  return clause;
}

function orderClause(
  sql: SqlClient,
  sortBy: LateralMasterSortColumn | null,
  sortDirection: LateralMasterSortDirection
) {
  const dir = sortDirection === "asc" ? sql`ASC` : sql`DESC`;
  if (!sortBy) {
    return sql`ORDER BY job_requisition_id ASC`;
  }
  switch (sortBy) {
    case "job_requisition_id":
      return sql`ORDER BY job_requisition_id ${dir} NULLS LAST`;
    case "date":
      return sql`ORDER BY date ${dir} NULLS LAST, job_requisition_id ASC`;
    case "priority":
      return sql`ORDER BY priority ${dir} NULLS LAST, job_requisition_id ASC`;
    case "skill_categorization":
      return sql`ORDER BY skill_categorization ${dir} NULLS LAST, job_requisition_id ASC`;
    case "primary_skills":
      return sql`ORDER BY primary_skills ${dir} NULLS LAST, job_requisition_id ASC`;
    case "job_management_level":
      return sql`ORDER BY job_management_level ${dir} NULLS LAST, job_requisition_id ASC`;
    case "primary_location":
      return sql`ORDER BY primary_location ${dir} NULLS LAST, job_requisition_id ASC`;
    case "market_map":
      return sql`ORDER BY market_map ${dir} NULLS LAST, job_requisition_id ASC`;
    case "poc":
      return sql`ORDER BY poc ${dir} NULLS LAST, job_requisition_id ASC`;
    case "job_status":
      return sql`ORDER BY job_status ${dir} NULLS LAST, job_requisition_id ASC`;
    case "posted":
      return sql`ORDER BY posted ${dir} NULLS LAST, job_requisition_id ASC`;
    case "created_at":
      return sql`ORDER BY created_at ${dir} NULLS LAST, job_requisition_id ASC`;
    case "updated_at":
      return sql`ORDER BY updated_at ${dir} NULLS LAST, job_requisition_id ASC`;
    case "last_seen_at":
      return sql`ORDER BY last_seen_at ${dir} NULLS LAST, job_requisition_id ASC`;
    default:
      return sql`ORDER BY job_requisition_id ASC`;
  }
}

/** Total rows in `lateral_master` (unfiltered). */
export async function countLateralMasterRows(
  sqlClient?: SqlClient
): Promise<number> {
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM lateral_master
  `;
  return Number(rows[0]?.c ?? 0);
}

/** Count rows matching optional filters. */
export async function countLateralMaster(
  filters?: LateralMasterQueryFilters,
  sqlClient?: SqlClient
): Promise<number> {
  const sql = sqlClient ?? getDbClient();
  const where = whereClause(sql, filters);
  const rows = await sql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM lateral_master
    ${where}
  `;
  return Number(rows[0]?.c ?? 0);
}

/**
 * Paginated read of `lateral_master` business columns.
 * Read-only SELECT — no writes.
 */
export async function queryLateralMaster(
  query: LateralMasterPageQuery = {},
  sqlClient?: SqlClient
): Promise<LateralMasterPageResult> {
  const sql = sqlClient ?? getDbClient();
  const { page, pageSize, offset } = resolvePage(query.page, query.pageSize);
  const { sortBy, sortDirection } = resolveSort(
    query.sortBy,
    query.sortDirection
  );
  const where = whereClause(sql, query.filters);
  const order = orderClause(sql, sortBy, sortDirection);

  const [countRows, dataRows] = await Promise.all([
    sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM lateral_master
      ${where}
    `,
    sql<Record<string, unknown>[]>`
      SELECT
        job_requisition_id,
        date::text AS date,
        priority,
        job_description,
        skill_categorization,
        primary_skills,
        job_management_level,
        primary_location,
        market_map,
        poc,
        job_status,
        posted,
        created_at,
        updated_at,
        last_seen_at
      FROM lateral_master
      ${where}
      ${order}
      LIMIT ${pageSize}
      OFFSET ${offset}
    `,
  ]);

  const total = Number(countRows[0]?.c ?? 0);
  const pageCount = total === 0 ? 0 : Math.ceil(total / pageSize);

  return {
    rows: dataRows.map(mapRow),
    total,
    page,
    pageSize,
    pageCount,
    sortBy,
    sortDirection,
  };
}

/**
 * All rows matching filters (for P-Roles aggregation).
 * No artificial top-N here — callers apply Top N on the aggregated table.
 */
export async function listLateralMasterRows(
  filters?: LateralMasterQueryFilters,
  options?: {
    sortBy?: LateralMasterSortColumn | null;
    sortDirection?: LateralMasterSortDirection;
    sqlClient?: SqlClient;
  }
): Promise<LateralMasterRow[]> {
  const sql = options?.sqlClient ?? getDbClient();
  const { sortBy, sortDirection } = resolveSort(
    options?.sortBy,
    options?.sortDirection
  );
  const where = whereClause(sql, filters);
  const order = orderClause(sql, sortBy, sortDirection);

  const dataRows = await sql<Record<string, unknown>[]>`
    SELECT
      job_requisition_id,
      date::text AS date,
      priority,
      job_description,
      skill_categorization,
      primary_skills,
      job_management_level,
      primary_location,
      market_map,
      poc,
      job_status,
      posted,
      created_at,
      updated_at,
      last_seen_at
    FROM lateral_master
    ${where}
    ${order}
  `;

  return dataRows.map(mapRow);
}

/** Map a PG row to the native P-Roles engine input shape. */
export function toPRolesRowFromMaster(row: LateralMasterRow): LateralMasterPRolesRow {
  return {
    jobRequisitionId: row.job_requisition_id ?? "",
    primarySkills: row.primary_skills ?? "",
    skillCategorization: row.skill_categorization ?? "",
    jobManagementLevel: row.job_management_level ?? "",
    jobStatus: row.job_status ?? "",
    posted: row.posted ?? "",
    marketMap: row.market_map ?? "",
  };
}

/**
 * P-Roles detail rows from PostgreSQL (filtered, unsorted beyond JR default).
 * Ready for NativePRolesEngine in Phase 8.2 — not wired yet.
 */
export async function listLateralMasterForPRoles(
  filters?: LateralMasterPRolesFilters,
  sqlClient?: SqlClient
): Promise<LateralMasterPRolesRow[]> {
  const rows = await listLateralMasterRows(
    {
      jobStatus: filters?.jobStatus,
      posted: filters?.posted,
      marketMap: filters?.marketMap,
    },
    { sqlClient, sortBy: null }
  );
  return rows.map(toPRolesRowFromMaster);
}

/**
 * Distinct non-empty values for a filterable column (dashboard filter schema).
 * Ordered A→Z, case-insensitive.
 */
export async function listLateralMasterDistinctValues(
  column: LateralMasterFilterValueColumn,
  sqlClient?: SqlClient
): Promise<string[]> {
  if (!FILTER_VALUE_SET.has(column)) {
    throw new Error(
      `[read-lateral-master] Column "${column}" is not allowed for distinct values.`
    );
  }
  const sql = sqlClient ?? getDbClient();

  let rows: Array<{ value: string }>;
  switch (column) {
    case "job_status":
      rows = await sql<{ value: string }[]>`
        SELECT DISTINCT job_status AS value FROM lateral_master
        WHERE job_status IS NOT NULL AND btrim(job_status) <> ''
        ORDER BY value ASC
      `;
      break;
    case "posted":
      rows = await sql<{ value: string }[]>`
        SELECT DISTINCT posted AS value FROM lateral_master
        WHERE posted IS NOT NULL AND btrim(posted) <> ''
        ORDER BY value ASC
      `;
      break;
    case "market_map":
      rows = await sql<{ value: string }[]>`
        SELECT DISTINCT market_map AS value FROM lateral_master
        WHERE market_map IS NOT NULL AND btrim(market_map) <> ''
        ORDER BY value ASC
      `;
      break;
    case "priority":
      rows = await sql<{ value: string }[]>`
        SELECT DISTINCT priority AS value FROM lateral_master
        WHERE priority IS NOT NULL AND btrim(priority) <> ''
        ORDER BY value ASC
      `;
      break;
    case "skill_categorization":
      rows = await sql<{ value: string }[]>`
        SELECT DISTINCT skill_categorization AS value FROM lateral_master
        WHERE skill_categorization IS NOT NULL AND btrim(skill_categorization) <> ''
        ORDER BY value ASC
      `;
      break;
    case "primary_skills":
      rows = await sql<{ value: string }[]>`
        SELECT DISTINCT primary_skills AS value FROM lateral_master
        WHERE primary_skills IS NOT NULL AND btrim(primary_skills) <> ''
        ORDER BY value ASC
      `;
      break;
    case "job_management_level":
      rows = await sql<{ value: string }[]>`
        SELECT DISTINCT job_management_level AS value FROM lateral_master
        WHERE job_management_level IS NOT NULL AND btrim(job_management_level) <> ''
        ORDER BY value ASC
      `;
      break;
    case "primary_location":
      rows = await sql<{ value: string }[]>`
        SELECT DISTINCT primary_location AS value FROM lateral_master
        WHERE primary_location IS NOT NULL AND btrim(primary_location) <> ''
        ORDER BY value ASC
      `;
      break;
    case "poc":
      rows = await sql<{ value: string }[]>`
        SELECT DISTINCT poc AS value FROM lateral_master
        WHERE poc IS NOT NULL AND btrim(poc) <> ''
        ORDER BY value ASC
      `;
      break;
    default:
      throw new Error(`[read-lateral-master] Unsupported distinct column.`);
  }

  return rows.map((r) => r.value);
}

/** Single-row lookup by Job Requisition ID. */
export async function getLateralMasterByJobRequisitionId(
  jobRequisitionId: string,
  sqlClient?: SqlClient
): Promise<LateralMasterRow | null> {
  const jr = String(jobRequisitionId ?? "").trim();
  if (!jr) return null;
  const page = await queryLateralMaster(
    {
      filters: { jobRequisitionIds: [jr] },
      page: 1,
      pageSize: 1,
    },
    sqlClient
  );
  return page.rows[0] ?? null;
}
