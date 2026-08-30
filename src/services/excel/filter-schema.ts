/**
 * Discover filterable columns/values for a business unit.
 *
 * Phase 8.3: Lateral Accenture Dashboard filters come from PostgreSQL
 * `lateral_master` (Job Status / Posted / Market Map + other PG-backed
 * categoricals). Executive / Consulting remain Excel/Drive-backed.
 *
 * `options.bypassCache` is accepted for API compatibility; the Lateral
 * PostgreSQL path has no workbook cache to bust.
 */
import { discoverFilterFields } from "@/services/excel/discover-filters";
import type { DynamicFilterSchema } from "@/services/excel/discover-filters";
import { readFilterSourceSheet } from "@/services/excel/reader";
import { getLateralDashboardFilterSchemaFromPostgres } from "@/services/persistence/lateral-dashboard-filter-schema";
import type { BusinessUnitId } from "@/types/business-unit";
import type { ExcelReaderOptions } from "@/types/excel";

export async function getDynamicFilterSchema(
  businessUnitId: BusinessUnitId,
  options?: ExcelReaderOptions
): Promise<DynamicFilterSchema> {
  if (businessUnitId === "lateral") {
    void options?.bypassCache;
    return getLateralDashboardFilterSchemaFromPostgres();
  }

  const sheet = await readFilterSourceSheet(businessUnitId, options);
  const fields = discoverFilterFields(sheet.headers, sheet.rows);

  return {
    businessUnitId,
    sheetName: sheet.sheetName,
    sourceFile: sheet.sourceFile || sheet.sourceLabel,
    fields,
  };
}
