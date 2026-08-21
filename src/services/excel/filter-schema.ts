import { discoverFilterFields } from "@/services/excel/discover-filters";
import type {
  DynamicFilterField,
  DynamicFilterSchema,
} from "@/services/excel/discover-filters";
import { readFilterSourceSheet } from "@/services/excel/reader";
import { LATERAL_JOB_STATUS_FILTER_VALUES } from "@/services/excel/lateral-master-sheet";
import { DEFAULT_FILTER_CONFIG } from "@/constants/default-filters";
import type { BusinessUnitId } from "@/types/business-unit";
import type { ExcelReaderOptions } from "@/types/excel";

function mergePreferredValues(existing: string[], preferred: readonly string[]) {
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

function ensureLateralDashboardFilterField(
  fields: DynamicFilterField[],
  headers: string[],
  match: RegExp,
  preferredValues: readonly string[]
) {
  const header = headers.find((name) => match.test(name));
  if (!header) return;

  let field = fields.find((item) => item.column === header);
  if (!field) {
    field = {
      column: header,
      values: [],
      valueCount: 0,
      kind: "categorical",
    };
    const insertAt = headers.indexOf(header);
    const after = fields.findIndex(
      (item) => headers.indexOf(item.column) > insertAt
    );
    if (after === -1) fields.push(field);
    else fields.splice(after, 0, field);
  }

  field.values = mergePreferredValues(field.values, preferredValues);
  field.valueCount = field.values.length;
}

function enrichLateralDashboardFilterFields(
  fields: DynamicFilterField[],
  headers: string[]
) {
  const statusOrder = [
    ...DEFAULT_FILTER_CONFIG.lateral.preferredStatusValues,
    ...LATERAL_JOB_STATUS_FILTER_VALUES.filter(
      (value) =>
        !DEFAULT_FILTER_CONFIG.lateral.preferredStatusValues.some(
          (preferred) => preferred.toLowerCase() === value.toLowerCase()
        )
    ),
  ];
  ensureLateralDashboardFilterField(
    fields,
    headers,
    /job\s*status/i,
    statusOrder
  );
  ensureLateralDashboardFilterField(fields, headers, /^posted$/i, [
    ...DEFAULT_FILTER_CONFIG.lateral.preferredPostedValues,
  ]);
}

/**
 * Read the active filter source sheet and discover filterable columns/values.
 * For Lateral, this is Master Sheet in the reference workbook
 * (so Job Status / Posted / Market Map appear as filters).
 */
export async function getDynamicFilterSchema(
  businessUnitId: BusinessUnitId,
  options?: ExcelReaderOptions
): Promise<DynamicFilterSchema> {
  const sheet = await readFilterSourceSheet(businessUnitId, options);
  const fields = discoverFilterFields(sheet.headers, sheet.rows);
  if (businessUnitId === "lateral") {
    enrichLateralDashboardFilterFields(fields, sheet.headers);
  }

  return {
    businessUnitId,
    sheetName: sheet.sheetName,
    sourceFile: sheet.sourceFile || sheet.sourceLabel,
    fields,
  };
}
