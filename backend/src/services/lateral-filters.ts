import {
  LATERAL_DASHBOARD_FILTER_COLUMN_MAP,
  LATERAL_JOB_STATUS_FILTER_VALUES,
  LATERAL_PREFERRED_POSTED_VALUES,
  LATERAL_PREFERRED_STATUS_VALUES,
  MAX_UNIQUE_VALUES,
  MIN_UNIQUE_VALUES,
  distinctValuesSql,
} from "../constants/lateral-filters.js";
import { queryRows } from "../db.js";
import type {
  DynamicFilterField,
  DynamicFilterSchema,
  LateralMasterFilterValueColumn,
} from "../types/lateral-filters.js";

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

function enrichLateralDashboardFilterFields(fields: DynamicFilterField[]): void {
  const statusOrder = [
    ...LATERAL_PREFERRED_STATUS_VALUES,
    ...LATERAL_JOB_STATUS_FILTER_VALUES.filter(
      (value) =>
        !LATERAL_PREFERRED_STATUS_VALUES.some(
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
        ...LATERAL_PREFERRED_POSTED_VALUES,
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

async function listLateralMasterDistinctValues(
  column: LateralMasterFilterValueColumn
): Promise<string[]> {
  const rows = await queryRows<{ value: string }>(distinctValuesSql(column));
  return rows.map((row) => row.value);
}

export async function getLateralDashboardFilterSchemaFromPostgres(): Promise<DynamicFilterSchema> {
  const fields: DynamicFilterField[] = [];

  for (const mapping of LATERAL_DASHBOARD_FILTER_COLUMN_MAP) {
    const values = await listLateralMasterDistinctValues(mapping.pg);
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
