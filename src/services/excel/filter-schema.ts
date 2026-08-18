import { discoverFilterFields } from "@/services/excel/discover-filters";
import type { DynamicFilterSchema } from "@/services/excel/discover-filters";
import { readFilterSourceSheet } from "@/services/excel/reader";
import type { BusinessUnitId } from "@/types/business-unit";
import type { ExcelReaderOptions } from "@/types/excel";

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

  return {
    businessUnitId,
    sheetName: sheet.sheetName,
    sourceFile: sheet.sourceFile || sheet.sourceLabel,
    fields,
  };
}
