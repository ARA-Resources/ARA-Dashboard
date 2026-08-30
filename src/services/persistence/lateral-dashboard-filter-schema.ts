/**
 * Phase 8.3 — Lateral Dashboard filter schema from PostgreSQL `lateral_master`.
 *
 * Builds the same `DynamicFilterSchema` contract the Accenture dashboard
 * consumes via `/api/excel/lateral/filters`, using Excel-compatible column
 * labels (Job Status / Posted / Market Map) so existing columnFilters keys
 * continue to work with the Phase 8.2 P-Roles API.
 *
 * Read-only. No Excel/Drive I/O. No schema changes.
 */
import type {
  DynamicFilterField,
  DynamicFilterSchema,
} from "@/services/excel/discover-filters";
import { LATERAL_JOB_STATUS_FILTER_VALUES } from "@/services/excel/lateral-master-sheet";
import { DEFAULT_FILTER_CONFIG } from "@/constants/default-filters";
import {
  listLateralMasterDistinctValues,
  type LateralMasterFilterValueColumn,
  type SqlClient,
} from "@/services/persistence/read-lateral-master";

/** Align with discover-filters cardinality heuristics. */
const MAX_UNIQUE_VALUES = 150;
const MIN_UNIQUE_VALUES = 2;

/**
 * PG column → Excel Master Sheet header label used by the dashboard.
 * Only fields that exist on `lateral_master` (approved schema).
 */
const LATERAL_DASHBOARD_FILTER_COLUMN_MAP: ReadonlyArray<{
  pg: LateralMasterFilterValueColumn;
  excelHeader: string;
  /** Always include even if unique count is low (dashboard defaults). */
  required?: boolean;
}> = [
  { pg: "job_status", excelHeader: "Job Status", required: true },
  { pg: "posted", excelHeader: "Posted", required: true },
  { pg: "market_map", excelHeader: "Market Map", required: true },
  { pg: "priority", excelHeader: "Priority" },
  { pg: "skill_categorization", excelHeader: "Skill Categorization" },
  { pg: "job_management_level", excelHeader: "Job Management Level" },
  { pg: "primary_skills", excelHeader: "Primary Skills" },
  { pg: "primary_location", excelHeader: "Primary Location/Office Locate" },
  { pg: "poc", excelHeader: "POC" },
];

function mergePreferredValues(
  existing: string[],
  preferred: readonly string[]
): string[] {
  const byKey = new Map<string, string>();
  for (const value of existing) {
    const key = value.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, value);
  }
  const ordered: string[] = [];
  for (const wanted of preferred) {
    const key = wanted.toLowerCase();
    ordered.push(byKey.get(key) ?? wanted);
    byKey.delete(key);
  }
  for (const rest of byKey.values()) ordered.push(rest);
  return ordered;
}

function enrichLateralDashboardFilterFields(fields: DynamicFilterField[]) {
  const statusOrder = [
    ...DEFAULT_FILTER_CONFIG.lateral.preferredStatusValues,
    ...LATERAL_JOB_STATUS_FILTER_VALUES.filter(
      (value) =>
        !DEFAULT_FILTER_CONFIG.lateral.preferredStatusValues.some(
          (preferred) => preferred.toLowerCase() === value.toLowerCase()
        )
    ),
  ];

  for (const field of fields) {
    if (/job\s*status/i.test(field.column)) {
      field.values = mergePreferredValues(field.values, statusOrder);
      field.valueCount = field.values.length;
    } else if (/^posted$/i.test(field.column)) {
      field.values = mergePreferredValues(field.values, [
        ...DEFAULT_FILTER_CONFIG.lateral.preferredPostedValues,
      ]);
      field.valueCount = field.values.length;
    }
  }
}

function isCardinalityOk(unique: number, required: boolean): boolean {
  if (required) return unique >= 1;
  if (unique < MIN_UNIQUE_VALUES) return false;
  if (unique > MAX_UNIQUE_VALUES) return false;
  return true;
}

/**
 * Lateral Accenture Dashboard filter schema from `lateral_master`.
 */
export async function getLateralDashboardFilterSchemaFromPostgres(
  sqlClient?: SqlClient
): Promise<DynamicFilterSchema> {
  const fields: DynamicFilterField[] = [];

  for (const mapping of LATERAL_DASHBOARD_FILTER_COLUMN_MAP) {
    const values = await listLateralMasterDistinctValues(
      mapping.pg,
      sqlClient
    );
    if (!isCardinalityOk(values.length, Boolean(mapping.required))) {
      continue;
    }
    fields.push({
      column: mapping.excelHeader,
      values,
      valueCount: values.length,
      kind: "categorical",
    });
  }

  enrichLateralDashboardFilterFields(fields);

  return {
    businessUnitId: "lateral",
    sheetName: "Master Sheet",
    sourceFile: "lateral_master",
    fields,
  };
}
