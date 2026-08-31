import { readLateralDataProcessingSetup } from "../lateral-setup-store.js";
import {
  applyLateralMasterFilters,
  discoverLateralMasterFilters,
  LATERAL_MASTER_HEADER_ROW,
  LATERAL_MASTER_SHEET_NAME,
  paginateRows,
  type LateralMasterFilterSchema,
  type LateralMasterPageSize,
  type LateralMasterSheetPageResult,
  type LateralMasterSheetQuery,
} from "./lateral-master-sheet.js";
import { readLateralMasterSheetFromDatasetFile } from "./read-lateral-master-from-dataset.js";
import { readLateralMasterSheetFromDriveXlsm } from "./read-lateral-master-from-drive-xlsm.js";
import type { ExcelReadResult, ExcelReaderOptions } from "../../types/excel.js";

function sourceUrlFromMeta(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  if (/^https?:\/\//i.test(filePath)) return filePath;
  return undefined;
}

async function resolveMasterSheetName(): Promise<string> {
  try {
    const setup = await readLateralDataProcessingSetup();
    if (setup?.masterSheet?.trim()) return setup.masterSheet.trim();
  } catch {
    // fall through to default
  }
  return LATERAL_MASTER_SHEET_NAME;
}

export async function readLateralMasterSheet(
  options?: ExcelReaderOptions
): Promise<ExcelReadResult> {
  const sheetName = options?.sheetName?.trim() || (await resolveMasterSheetName());
  const headerRow = options?.headerRow ?? LATERAL_MASTER_HEADER_ROW;

  try {
    return await readLateralMasterSheetFromDriveXlsm({
      sheetName,
      headerRow,
      readerOptions: options,
    });
  } catch (error) {
    console.warn(
      "[excel] Lateral Master Sheet Drive XLSM read failed; falling back to Dataset Manager workbook.",
      error instanceof Error ? error.message : error
    );
  }

  return readLateralMasterSheetFromDatasetFile(sheetName, headerRow, options);
}

export async function getLateralMasterFilterSchema(
  options?: ExcelReaderOptions
): Promise<LateralMasterFilterSchema> {
  const sheet = await readLateralMasterSheet(options);
  return {
    sheetName: sheet.sheetName,
    sourceFile: sheet.sourceFile,
    sourceUrl: sourceUrlFromMeta(sheet.meta.filePath),
    headers: sheet.headers,
    fields: discoverLateralMasterFilters(sheet.headers, sheet.rows),
  };
}

export async function queryLateralMasterSheet(
  query: LateralMasterSheetQuery,
  options?: ExcelReaderOptions
): Promise<LateralMasterSheetPageResult> {
  const sheet = await readLateralMasterSheet(options);
  const filtered = applyLateralMasterFilters(sheet.rows, query);
  const page = paginateRows(filtered, query.page, query.pageSize);

  return {
    businessUnitId: "lateral",
    sheetName: sheet.sheetName,
    sourceFile: sheet.sourceFile,
    sourceUrl: sourceUrlFromMeta(sheet.meta.filePath),
    headers: sheet.headers,
    rows: page.rows,
    total: page.total,
    page: page.page,
    pageSize: page.pageSize as LateralMasterPageSize,
    pageCount: page.pageCount,
    meta: sheet.meta,
  };
}
