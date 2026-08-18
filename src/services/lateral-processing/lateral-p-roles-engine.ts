import type { ExcelDataRow } from "@/types/excel";

export const P_ROLES_ENGINE_VALUES = ["excel", "native"] as const;
export type PRolesEngineKind = (typeof P_ROLES_ENGINE_VALUES)[number];

export const CANONICAL_JML_ORDER = [
  "8-Associate Manager",
  "9-Team Lead/Consultant",
  "10-Senior Analyst",
  "11-Analyst",
  "12-Associate",
] as const;

export type PRolesMasterRow = {
  jobRequisitionId: string;
  primarySkills: string;
  skillCategorization: string;
  jobManagementLevel: string;
  jobStatus: string;
  posted: string;
  marketMap: string;
};

export type PRolesFilterSelection = {
  jobStatus?: string[];
  posted?: string[];
  marketMap?: string[];
};

export type PRolesRow = {
  primarySkills: string;
  skillCategorization: string;
  byJml: Record<string, number>;
  grandTotal: number;
};

export type PRolesResult = {
  rows: PRolesRow[];
  columns: string[];
  filters: {
    jobStatus: string[];
    posted: string[];
    marketMap: string[];
  };
  totals: {
    totalJobs: number;
  };
  metadata: {
    source: "master-sheet";
    generatedAt: string;
    jmlOrder: string[];
    unknownJmlValues: string[];
    engine: PRolesEngineKind;
  };
};

export type PRolesEngineInput = {
  masterRows: PRolesMasterRow[];
  filters?: PRolesFilterSelection;
};

export type PRolesEngine = {
  kind: PRolesEngineKind;
  generate(input: PRolesEngineInput): Promise<PRolesResult>;
};

function normalizeFilterValues(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

export function normalizePRolesFilters(
  filters: PRolesFilterSelection | undefined
): PRolesFilterSelection {
  return {
    jobStatus: normalizeFilterValues(filters?.jobStatus),
    posted: normalizeFilterValues(filters?.posted),
    marketMap: normalizeFilterValues(filters?.marketMap),
  };
}

export function resolvePRolesEngineKind(): PRolesEngineKind {
  const raw = (process.env.ARA_P_ROLES_ENGINE ?? "").trim().toLowerCase();
  if (raw === "native") return "native";
  return "excel";
}

export function toLowerSet(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => value.toLowerCase()));
}

/**
 * Convert native P-Roles result to the existing openings-table shape.
 * Keeps the dashboard UI unchanged while feeding it JSON-native aggregation.
 */
export function pRolesResultToRows(result: PRolesResult): {
  headers: string[];
  rows: ExcelDataRow[];
} {
  const headers = ["Primary Skills", "Skill Categorization", ...result.columns, "Grand Total"];
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
