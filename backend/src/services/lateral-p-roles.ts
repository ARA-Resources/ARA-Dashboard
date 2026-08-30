/**
 * Stage 9: Lateral P-Roles openings from PostgreSQL `lateral_master`.
 *
 * Ports the Next.js postgres path:
 *   listLateralMasterForPRoles → NativePRolesEngine → applySortAndTopN
 * Drive/XLSM path is intentionally not included.
 */
import { queryRows } from "../db.js";
import type {
  ExcelDataRow,
  ExcelOpeningsResult,
  OpeningsFilters,
  PRolesMasterRow,
  SortDirection,
} from "../types/lateral-p-roles.js";

const CANONICAL_JML_ORDER = [
  "8-Associate Manager",
  "9-Team Lead/Consultant",
  "10-Senior Analyst",
  "11-Analyst",
  "12-Associate",
] as const;

type PRolesFilterSelection = {
  jobStatus?: string[];
  posted?: string[];
  marketMap?: string[];
};

type PRolesRow = {
  primarySkills: string;
  skillCategorization: string;
  byJml: Record<string, number>;
  grandTotal: number;
};

type PRolesResult = {
  rows: PRolesRow[];
  columns: string[];
  totals: { totalJobs: number };
  metadata: { engine: "native" };
};

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\u00a0/g, " ").trim();
}

function normalizeFilterValues(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

function toLowerSet(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => value.toLowerCase()));
}

function extractPRolesFilters(
  filters?: OpeningsFilters
): PRolesFilterSelection {
  return {
    jobStatus: filters?.columnFilters?.["Job Status"] ?? [],
    posted: filters?.columnFilters?.["Posted"] ?? [],
    marketMap: filters?.columnFilters?.["Market Map"] ?? [],
  };
}

function matchesSelection(value: string, selection: Set<string>): boolean {
  if (selection.size === 0) return true;
  return selection.has(value.toLowerCase());
}

function filterRows(
  rows: PRolesMasterRow[],
  filters: PRolesFilterSelection
): PRolesMasterRow[] {
  const jobStatusSelection = toLowerSet(filters.jobStatus);
  const postedSelection = toLowerSet(filters.posted);
  const marketMapSelection = toLowerSet(filters.marketMap);

  return rows.filter((row) => {
    if (!matchesSelection(row.jobStatus, jobStatusSelection)) return false;
    if (!matchesSelection(row.posted, postedSelection)) return false;
    if (!matchesSelection(row.marketMap, marketMapSelection)) return false;
    return true;
  });
}

function buildColumns(filteredRows: PRolesMasterRow[]): string[] {
  const known = new Set<string>(CANONICAL_JML_ORDER);
  const unknown: string[] = [];
  const unknownSet = new Set<string>();

  for (const row of filteredRows) {
    const jml = row.jobManagementLevel;
    if (!jml || known.has(jml)) continue;
    if (!unknownSet.has(jml)) {
      unknownSet.add(jml);
      unknown.push(jml);
    }
  }

  unknown.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return [...CANONICAL_JML_ORDER, ...unknown];
}

function aggregateRows(
  filteredRows: PRolesMasterRow[],
  columns: string[]
): { rows: PRolesRow[]; totalJobs: number } {
  const map = new Map<string, PRolesRow>();
  let totalJobs = 0;

  for (const row of filteredRows) {
    // CRITICAL: COUNT(Job Requisition ID), not COUNTA(row)
    if (!row.jobRequisitionId) continue;

    const primarySkills = row.primarySkills || "—";
    const skillCategorization = row.skillCategorization || "—";
    const key = `${primarySkills}\u0000${skillCategorization}`;
    const bucket =
      map.get(key) ??
      ({
        primarySkills,
        skillCategorization,
        byJml: Object.fromEntries(columns.map((column) => [column, 0])) as Record<
          string,
          number
        >,
        grandTotal: 0,
      } satisfies PRolesRow);

    const jml = row.jobManagementLevel || "—";
    if (!(jml in bucket.byJml)) {
      bucket.byJml[jml] = 0;
    }
    bucket.byJml[jml] += 1;
    bucket.grandTotal += 1;
    totalJobs += 1;
    map.set(key, bucket);
  }

  const rows = [...map.values()].sort((a, b) => {
    const primaryCmp = a.primarySkills.localeCompare(b.primarySkills, undefined, {
      sensitivity: "base",
    });
    if (primaryCmp !== 0) return primaryCmp;
    return a.skillCategorization.localeCompare(b.skillCategorization, undefined, {
      sensitivity: "base",
    });
  });

  return { rows, totalJobs };
}

function generateNativePRoles(
  masterRows: PRolesMasterRow[],
  filters: PRolesFilterSelection
): PRolesResult {
  const normalized: PRolesFilterSelection = {
    jobStatus: normalizeFilterValues(filters.jobStatus),
    posted: normalizeFilterValues(filters.posted),
    marketMap: normalizeFilterValues(filters.marketMap),
  };
  const filteredRows = filterRows(masterRows, normalized);
  const columns = buildColumns(filteredRows);
  const { rows, totalJobs } = aggregateRows(filteredRows, columns);

  return {
    rows,
    columns,
    totals: { totalJobs },
    metadata: { engine: "native" },
  };
}

function pRolesResultToRows(result: PRolesResult): {
  headers: string[];
  rows: ExcelDataRow[];
} {
  const headers = [
    "Primary Skills",
    "Skill Categorization",
    ...result.columns,
    "Grand Total",
  ];
  const rows: ExcelDataRow[] = result.rows.map((row, idx) => {
    const dataRow: ExcelDataRow = {
      id: `p-roles-native-${idx + 1}`,
      "Primary Skills": row.primarySkills,
      "Skill Categorization": row.skillCategorization,
      "Grand Total": row.grandTotal,
    };
    for (const column of result.columns) {
      dataRow[column] = row.byJml[column] ?? 0;
    }
    return dataRow;
  });
  return { headers, rows };
}

function applySortAndTopN(
  headers: string[],
  rows: ExcelDataRow[],
  filters: {
    sortBy: string | null;
    sortDirection: SortDirection;
    topN: number | null;
  }
): ExcelDataRow[] {
  const sorted = [...rows];
  const sortBy =
    filters.sortBy && headers.includes(filters.sortBy) ? filters.sortBy : null;

  if (sortBy) {
    sorted.sort((a, b) => {
      const left = a[sortBy];
      const right = b[sortBy];
      const leftNum = typeof left === "number" ? left : Number(left);
      const rightNum = typeof right === "number" ? right : Number(right);
      const leftValid = Number.isFinite(leftNum);
      const rightValid = Number.isFinite(rightNum);

      let comparison = 0;
      if (leftValid && rightValid) comparison = leftNum - rightNum;
      else comparison = asText(left).localeCompare(asText(right));

      return filters.sortDirection === "asc" ? comparison : -comparison;
    });
  }

  if (filters.topN === null || filters.topN === undefined) {
    return sorted;
  }

  return sorted.slice(0, Math.max(0, filters.topN));
}

/**
 * Load all Master rows for P-Roles aggregation.
 * Matches Next `listLateralMasterForPRoles()` with no SQL filters:
 * Job Status / Posted / Market Map are applied in the native engine.
 */
async function loadMasterRowsFromPostgres(): Promise<PRolesMasterRow[]> {
  const rows = await queryRows<{
    job_requisition_id: string | null;
    primary_skills: string | null;
    skill_categorization: string | null;
    job_management_level: string | null;
    job_status: string | null;
    posted: string | null;
    market_map: string | null;
  }>(
    `SELECT
       job_requisition_id,
       primary_skills,
       skill_categorization,
       job_management_level,
       job_status,
       posted,
       market_map
     FROM lateral_master
     ORDER BY job_requisition_id ASC`
  );

  return rows.map((row) => ({
    jobRequisitionId: row.job_requisition_id ?? "",
    primarySkills: row.primary_skills ?? "",
    skillCategorization: row.skill_categorization ?? "",
    jobManagementLevel: row.job_management_level ?? "",
    jobStatus: row.job_status ?? "",
    posted: row.posted ?? "",
    marketMap: row.market_map ?? "",
  }));
}

export async function buildLateralPRolesOpenings(
  filters?: OpeningsFilters
): Promise<ExcelOpeningsResult> {
  const masterRows = await loadMasterRowsFromPostgres();
  const pRolesFilters = extractPRolesFilters(filters);
  const result = generateNativePRoles(masterRows, pRolesFilters);
  const table = pRolesResultToRows(result);
  const ranked = applySortAndTopN(table.headers, table.rows, {
    sortBy: filters?.sortBy ?? null,
    sortDirection: filters?.sortDirection ?? "desc",
    topN: filters?.topN ?? null,
  }).map((row, index) => ({
    ...row,
    id: String(row.id ?? `p-roles-${index + 1}`),
  }));

  return {
    businessUnitId: "lateral",
    sheetName: "P-Roles",
    sourceFile: "lateral_master",
    sourceLabel: `PostgreSQL lateral_master → P-Roles (${result.metadata.engine})`,
    headers: table.headers,
    rows: ranked,
    appliedFilters: filters,
    meta: {
      name: "P-Roles",
      rowCount: ranked.length,
      columnCount: table.headers.length,
      headerRow: 1,
      filePath: "postgres:lateral_master",
      mtimeMs: 0,
      totalRows: table.rows.length,
      filteredDetailCount: result.totals.totalJobs,
      topN: filters?.topN ?? undefined,
      hasColumnFilters: Boolean(
        (filters?.columnFilters &&
          Object.keys(filters.columnFilters).length > 0) ||
          false
      ),
    },
  };
}
