import type { ExcelReadResult } from "@/types/excel";
import {
  CANONICAL_JML_ORDER,
  type PRolesEngine,
  type PRolesEngineInput,
  type PRolesFilterSelection,
  type PRolesMasterRow,
  type PRolesResult,
  normalizePRolesFilters,
  toLowerSet,
} from "@/services/lateral-processing/lateral-p-roles-engine";

const REQUIRED_MASTER_HEADERS = {
  jobRequisitionId: "Job Requisition ID",
  primarySkills: "Primary Skills",
  skillCategorization: "Skill Categorization",
  jobManagementLevel: "Job Management Level",
  jobStatus: "Job Status",
  posted: "Posted",
  marketMap: "Market Map",
} as const;

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\u00a0/g, " ").trim();
}

function headerIndexByName(headers: string[]): Map<string, number> {
  const map = new Map<string, number>();
  headers.forEach((header, idx) => {
    map.set(header.trim().toLowerCase(), idx);
  });
  return map;
}

function requireHeader(indexMap: Map<string, number>, expectedName: string): number {
  const idx = indexMap.get(expectedName.toLowerCase());
  if (idx === undefined) {
    throw new Error(`Master Sheet is missing required header "${expectedName}".`);
  }
  return idx;
}

export function toPRolesMasterRows(sheet: ExcelReadResult): PRolesMasterRow[] {
  const indexMap = headerIndexByName(sheet.headers);
  const jobRequisitionIdCol = requireHeader(indexMap, REQUIRED_MASTER_HEADERS.jobRequisitionId);
  const primarySkillsCol = requireHeader(indexMap, REQUIRED_MASTER_HEADERS.primarySkills);
  const skillCategorizationCol = requireHeader(indexMap, REQUIRED_MASTER_HEADERS.skillCategorization);
  const jobManagementLevelCol = requireHeader(indexMap, REQUIRED_MASTER_HEADERS.jobManagementLevel);
  const jobStatusCol = requireHeader(indexMap, REQUIRED_MASTER_HEADERS.jobStatus);
  const postedCol = requireHeader(indexMap, REQUIRED_MASTER_HEADERS.posted);
  const marketMapCol = requireHeader(indexMap, REQUIRED_MASTER_HEADERS.marketMap);

  return sheet.rows.map((row) => {
    const values = sheet.headers.map((header) => row[header]);
    return {
      jobRequisitionId: asText(values[jobRequisitionIdCol]),
      primarySkills: asText(values[primarySkillsCol]),
      skillCategorization: asText(values[skillCategorizationCol]),
      jobManagementLevel: asText(values[jobManagementLevelCol]),
      jobStatus: asText(values[jobStatusCol]),
      posted: asText(values[postedCol]),
      marketMap: asText(values[marketMapCol]),
    };
  });
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

type AggregateBucket = {
  primarySkills: string;
  skillCategorization: string;
  byJml: Record<string, number>;
  grandTotal: number;
};

function buildColumns(filteredRows: PRolesMasterRow[]): {
  columns: string[];
  unknownJmlValues: string[];
} {
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
  return {
    columns: [...CANONICAL_JML_ORDER, ...unknown],
    unknownJmlValues: unknown,
  };
}

function aggregateRows(
  filteredRows: PRolesMasterRow[],
  columns: string[]
): {
  rows: AggregateBucket[];
  totalJobs: number;
} {
  const map = new Map<string, AggregateBucket>();
  let totalJobs = 0;

  for (const row of filteredRows) {
    // CRITICAL: COUNT(Job Requisition ID), not COUNTA(row)
    if (!row.jobRequisitionId) continue;

    const primarySkills = row.primarySkills || "—";
    const skillCategorization = row.skillCategorization || "—";
    const key = `${primarySkills}\u0000${skillCategorization}`;
    const bucket =
      map.get(key) ??
      {
        primarySkills,
        skillCategorization,
        byJml: Object.fromEntries(columns.map((column) => [column, 0])) as Record<string, number>,
        grandTotal: 0,
      };

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

export async function generateNativePRoles(
  input: PRolesEngineInput
): Promise<PRolesResult> {
  const normalizedFilters = normalizePRolesFilters(input.filters);
  const filteredRows = filterRows(input.masterRows, normalizedFilters);
  const { columns, unknownJmlValues } = buildColumns(filteredRows);
  const { rows, totalJobs } = aggregateRows(filteredRows, columns);

  return {
    rows,
    columns,
    filters: {
      jobStatus: normalizedFilters.jobStatus ?? [],
      posted: normalizedFilters.posted ?? [],
      marketMap: normalizedFilters.marketMap ?? [],
    },
    totals: {
      totalJobs,
    },
    metadata: {
      source: "master-sheet",
      generatedAt: new Date().toISOString(),
      jmlOrder: columns,
      unknownJmlValues,
      engine: "native",
    },
  };
}

export const NativePRolesEngine: PRolesEngine = {
  kind: "native",
  generate: generateNativePRoles,
};
