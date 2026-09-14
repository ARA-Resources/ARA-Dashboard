/**
 * Executive Dashboard filter schema from PostgreSQL `executive_master`.
 *
 * Mirrors `lateral-dashboard-filter-schema.ts` for the Accenture Dashboard's
 * "All Filters" panel. Unlike that file, distinct values are computed
 * in-memory from `listExecutiveMasterRows()` rather than a per-column SQL
 * DISTINCT query — `executive_master` is small (~1.5k rows vs Lateral's
 * ~13k), and this is the same approach `discoverExecutiveMasterSheetFilters`
 * already uses for the Master Sheet page.
 *
 * `executive_master` has no POC-equivalent column, so this exposes 8 fields
 * where Lateral's dashboard schema exposes 9 (everything except POC).
 *
 * Read-only. No Excel/Drive I/O. No schema changes.
 */
import type {
  DynamicFilterField,
  DynamicFilterSchema,
} from "@/services/excel/discover-filters";
import { DEFAULT_FILTER_CONFIG } from "@/constants/default-filters";
import {
  listExecutiveMasterRows,
  type ExecutiveMasterRow,
  type SqlClient,
} from "@/services/persistence/read-executive-master";

/** Align with discover-filters cardinality heuristics. */
const MAX_UNIQUE_VALUES = 150;
const MIN_UNIQUE_VALUES = 2;

/**
 * DB column → Excel Master Sheet header label used by the dashboard.
 * Only fields that exist on `executive_master`.
 */
const EXECUTIVE_DASHBOARD_FILTER_COLUMN_MAP: ReadonlyArray<{
  dbColumn: keyof ExecutiveMasterRow;
  excelHeader: string;
  /** Always include even if unique count is low (dashboard defaults). */
  required?: boolean;
}> = [
  { dbColumn: "job_status", excelHeader: "Job Status", required: true },
  { dbColumn: "posted", excelHeader: "Posted", required: true },
  { dbColumn: "market_map", excelHeader: "Market Map", required: true },
  { dbColumn: "priority", excelHeader: "Priority" },
  { dbColumn: "skill_categorization", excelHeader: "Skill Categorization" },
  { dbColumn: "job_management_level", excelHeader: "Job Management Level" },
  { dbColumn: "primary_skills", excelHeader: "Primary Skills" },
  { dbColumn: "primary_location", excelHeader: "Primary Location" },
];

function collectDistinctValues(
  rows: ExecutiveMasterRow[],
  dbColumn: keyof ExecutiveMasterRow
): string[] {
  const byKey = new Map<string, string>();
  for (const row of rows) {
    const raw = row[dbColumn];
    if (raw === null || raw === undefined) continue;
    const text = String(raw).trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, text);
  }
  return [...byKey.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

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

function enrichExecutiveDashboardFilterFields(fields: DynamicFilterField[]) {
  for (const field of fields) {
    if (/^job\s*status$/i.test(field.column)) {
      field.values = mergePreferredValues(field.values, [
        ...DEFAULT_FILTER_CONFIG.executive.preferredStatusValues,
      ]);
      field.valueCount = field.values.length;
    } else if (/^posted$/i.test(field.column)) {
      field.values = mergePreferredValues(field.values, [
        ...DEFAULT_FILTER_CONFIG.executive.preferredPostedValues,
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
 * Executive Accenture Dashboard filter schema from `executive_master`.
 */
export async function getExecutiveDashboardFilterSchemaFromPostgres(
  sqlClient?: SqlClient
): Promise<DynamicFilterSchema> {
  const rows = await listExecutiveMasterRows(sqlClient);
  const fields: DynamicFilterField[] = [];

  for (const mapping of EXECUTIVE_DASHBOARD_FILTER_COLUMN_MAP) {
    const values = collectDistinctValues(rows, mapping.dbColumn);
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

  enrichExecutiveDashboardFilterFields(fields);

  return {
    businessUnitId: "executive",
    sheetName: "Master Sheet",
    sourceFile: "executive_master",
    fields,
  };
}
