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
import {
  LATERAL_MASTER_PG_SOURCE_FILE,
  LATERAL_MASTER_PG_SOURCE_LABEL,
} from "@/services/persistence/lateral-master-sheet-columns";
import { listLateralMasterAsExcelRows } from "@/services/persistence/read-lateral-master";
import type { ExcelDataRow, ExcelReadResult, ExcelReaderOptions } from "@/types/excel";

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
 * Master Sheet data source for the /lateral dashboard.
 * Default: postgres (VPS `lateral_master`). Set ARA_LATERAL_MASTER_SOURCE=drive
 * to fall back to the Drive XLSM pipeline reader (does not change import).
 */
export function resolveLateralMasterSheetSource(): "postgres" | "drive" {
  const raw = (process.env.ARA_LATERAL_MASTER_SOURCE ?? "postgres")
    .trim()
    .toLowerCase();
  return raw === "drive" ? "drive" : "postgres";
}

async function readLateralMasterSheetFromPostgres(): Promise<ExcelReadResult> {
  const sheetName = await resolveMasterSheetName();
  const payload = await listLateralMasterAsExcelRows();
  const rows: ExcelDataRow[] = payload.rows.map((row, index) => {
    const jr = String(row["Job Requisition ID"] ?? "").trim();
    return {
      id: jr ? `pg-master-${jr}` : `pg-master-row-${index + 1}`,
      ...row,
    };
  });

  return {
    businessUnitId: "lateral",
    sheetName,
    sourceFile: LATERAL_MASTER_PG_SOURCE_FILE,
    sourceLabel: LATERAL_MASTER_PG_SOURCE_LABEL,
    headers: payload.headers,
    rows,
    meta: {
      name: sheetName,
      rowCount: rows.length,
      columnCount: payload.headers.length,
      headerRow: LATERAL_MASTER_HEADER_ROW,
      filePath: LATERAL_MASTER_PG_SOURCE_LABEL,
      totalRows: rows.length,
    },
  };
}

/**
 * Company → Accenture → Lateral → Master Sheet.
 * Default reads PostgreSQL `lateral_master`. Drive XLSM remains available when
 * ARA_LATERAL_MASTER_SOURCE=drive (pipeline / other features unchanged).
 */
export async function readLateralMasterSheet(
  options?: ExcelReaderOptions
): Promise<ExcelReadResult> {
  if (resolveLateralMasterSheetSource() === "postgres") {
    return readLateralMasterSheetFromPostgres();
  }

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
  const { getLateralMasterLastRunBanner } = await import(
    "@/services/persistence/lateral-master-last-run"
  );
  const lastRun = await getLateralMasterLastRunBanner().catch(() => null);
  return {
    sheetName: sheet.sheetName,
    sourceFile: sheet.sourceFile,
    sourceUrl: sourceUrlFromMeta(sheet.meta.filePath),
    headers: sheet.headers,
    fields: discoverLateralMasterFilters(sheet.headers, sheet.rows),
    lastRun,
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
