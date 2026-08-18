import "server-only";

import { readLateralDataProcessingSetup } from "@/services/lateral-processing/setup-store";
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
} from "@/services/excel/lateral-master-sheet";
import { readLateralMasterSheetFromDriveXlsm } from "@/services/excel/read-lateral-master-from-drive-xlsm";
import { buildMasterSheetXlsxBuffer } from "@/services/excel/build-master-sheet-xlsx";
import { readSheetFromFileForLateralMaster } from "@/services/excel/reader";
import type { ExcelReadResult, ExcelReaderOptions } from "@/types/excel";

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

/**
 * Company → Accenture → Lateral → Master Sheet reads the Drive XLSM
 * (processing Master Workbook). Dataset Manager current file is fallback only.
 */
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

  return readSheetFromFileForLateralMaster(sheetName, headerRow, options);
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

/**
 * Export the entire Master Sheet as .xlsx (row 1 = headers, AutoFilter on).
 * Dashboard UI filters are ignored so Excel gets the full table.
 */
export async function exportLateralMasterSheetXlsx(
  options?: ExcelReaderOptions
): Promise<{
  buffer: Buffer;
  fileName: string;
  rowCount: number;
  sheetName: string;
}> {
  const sheet = await readLateralMasterSheet(options);

  const buffer = await buildMasterSheetXlsxBuffer({
    sheetName: sheet.sheetName || LATERAL_MASTER_SHEET_NAME,
    headers: sheet.headers,
    rows: sheet.rows,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const fileName = `Lateral-Master-Sheet-${stamp}.xlsx`;

  return {
    buffer,
    fileName,
    rowCount: sheet.rows.length,
    sheetName: sheet.sheetName || LATERAL_MASTER_SHEET_NAME,
  };
}
