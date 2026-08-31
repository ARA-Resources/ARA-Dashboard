import type { ExcelReaderOptions } from "../../types/excel.js";
import type { DynamicFilterSchema } from "./discover-filters.js";
import { discoverFilterFields } from "./discover-filters.js";
import { readConsultingSheet } from "./consulting-reader.js";

export async function getConsultingFilterSchema(
  options?: ExcelReaderOptions
): Promise<DynamicFilterSchema> {
  const sheet = await readConsultingSheet(options);
  const fields = discoverFilterFields(sheet.headers, sheet.rows);

  return {
    businessUnitId: "consulting",
    sheetName: sheet.sheetName,
    sourceFile: sheet.sourceFile || sheet.sourceLabel,
    fields,
  };
}
