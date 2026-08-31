import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  assertConfiguredExecutiveExcelPath,
  getBundledExecutiveExcelPath,
  getExecutiveExcelPath,
} from "../../config/runtime.js";
import type { ExcelReadResult, ExcelReaderOptions } from "../../types/excel.js";
import {
  assertExecutiveMasterHeaders,
  applyExecutiveMasterFilters,
  discoverExecutiveMasterFilters,
  EXECUTIVE_MASTER_HEADER_ROW,
  EXECUTIVE_MASTER_SHEET_NAME,
  paginateExecutiveRows,
  projectExecutiveMasterLiveColumns,
  type ExecutiveMasterFilterSchema,
  type ExecutiveMasterPageSize,
  type ExecutiveMasterSheetPageResult,
  type ExecutiveMasterSheetQuery,
  type ExecutiveMasterDataSourceKind,
  type ExecutiveMasterSheetReadResult,
} from "./executive-master-sheet.js";
import {
  hasExecutiveMasterDriveFileIdConfigured,
  readExecutiveMasterSheetFromDriveXlsm,
} from "./read-executive-master-from-drive-xlsm.js";
import { parseWorksheet } from "./parse-sheet.js";
import { resolveReadableExcelPath } from "./readable-workbook.js";

interface LocalCacheEntry {
  mtimeMs: number;
  payload: ExcelReadResult;
}

const localMemoryCache = new Map<string, LocalCacheEntry>();

function finalizeExecutiveMasterResult(
  sheet: ExcelReadResult,
  sourceKind: ExecutiveMasterDataSourceKind
): ExecutiveMasterSheetReadResult {
  if (!sheet.headers.length) {
    throw new Error(
      "Executive Master Sheet could not be loaded: malformed or missing headers."
    );
  }

  assertExecutiveMasterHeaders(sheet.headers);

  const projected = projectExecutiveMasterLiveColumns(
    sheet.headers,
    sheet.rows
  );

  if (projected.rows.length === 0) {
    throw new Error(
      "Executive Master Sheet could not be loaded: Master Sheet has no data rows."
    );
  }

  const headerRow = sheet.meta.headerRow ?? EXECUTIVE_MASTER_HEADER_ROW;
  if (headerRow !== EXECUTIVE_MASTER_HEADER_ROW) {
    console.warn(
      `[excel] Executive Master Sheet headerRow is ${headerRow}; expected ${EXECUTIVE_MASTER_HEADER_ROW}.`
    );
  }

  return {
    businessUnitId: "executive",
    sheetName: sheet.sheetName || EXECUTIVE_MASTER_SHEET_NAME,
    sourceKind,
    sourceFile: sheet.sourceFile,
    sourceLabel: sheet.sourceLabel,
    headers: projected.headers,
    rows: projected.rows,
    meta: {
      ...sheet.meta,
      name: sheet.sheetName || EXECUTIVE_MASTER_SHEET_NAME,
      columnCount: projected.headers.length,
      rowCount: projected.rows.length,
      totalRows: projected.rows.length,
      headerRow: EXECUTIVE_MASTER_HEADER_ROW,
      sourceKind,
    },
  };
}

async function resolveLocalExecutiveWorkbookPath(): Promise<{
  filePath: string;
  sourceLabel: string;
  sourceKind: "local" | "bundled";
}> {
  assertConfiguredExecutiveExcelPath();

  const fromEnv = getExecutiveExcelPath();
  if (fromEnv) {
    return {
      filePath: fromEnv,
      sourceLabel: path.basename(fromEnv),
      sourceKind: "local",
    };
  }

  const bundled = getBundledExecutiveExcelPath();
  try {
    await fs.access(bundled);
    return {
      filePath: bundled,
      sourceLabel: path.basename(bundled),
      sourceKind: "bundled",
    };
  } catch {
    throw new Error(
      "Executive Master Sheet could not be loaded. Configure ARA_EXECUTIVE_MASTER_DRIVE_FILE_ID or ARA_EXECUTIVE_EXCEL_PATH, or provide data/excel/executive-mastersheet.xlsm."
    );
  }
}

export async function readExecutiveMasterSheetFromLocalFile(
  options?: ExcelReaderOptions
): Promise<ExecutiveMasterSheetReadResult> {
  const sheetName =
    options?.sheetName?.trim() || EXECUTIVE_MASTER_SHEET_NAME;
  const headerRow = options?.headerRow ?? EXECUTIVE_MASTER_HEADER_ROW;
  const { filePath, sourceLabel, sourceKind } =
    await resolveLocalExecutiveWorkbookPath();
  const stat = await fs.stat(filePath);
  const mtimeMs = stat.mtimeMs;
  const cacheKey = `executive-local:${filePath}:${sheetName}:${headerRow}`;
  const cached = localMemoryCache.get(cacheKey);
  if (cached && cached.mtimeMs === mtimeMs && !options?.bypassCache) {
    return finalizeExecutiveMasterResult(cached.payload, sourceKind);
  }

  const readablePath = await resolveReadableExcelPath(filePath);
  const excel = new ExcelJS.Workbook();
  await excel.xlsx.readFile(readablePath);
  const sheet =
    excel.worksheets.find(
      (item) =>
        item.name.trim().toLowerCase() === sheetName.trim().toLowerCase()
    ) ?? null;

  if (!sheet) {
    const available = excel.worksheets.map((item) => item.name).join(", ");
    throw new Error(
      `Sheet "${sheetName}" not found in Executive workbook. Available: ${available}`
    );
  }

  const parsed = parseWorksheet(sheet, { headerRow });
  const payload: ExcelReadResult = {
    businessUnitId: "executive",
    sheetName: parsed.sheetName,
    sourceFile: sourceLabel,
    sourceLabel:
      sourceKind === "bundled"
        ? `Bundled XLSM · ${sourceLabel}`
        : `Local XLSM · ${sourceLabel}`,
    headers: parsed.headers,
    rows: parsed.rows.map((row, index) => ({
      id: `executive-${sourceKind}-${parsed.sheetName}-${index + 1}`,
      ...row,
    })),
    meta: {
      name: parsed.sheetName,
      rowCount: parsed.rows.length,
      columnCount: parsed.headers.length,
      headerRow: parsed.headerRow,
      filePath: undefined,
      mtimeMs,
      totalRows: parsed.rows.length,
    },
  };

  localMemoryCache.set(cacheKey, { mtimeMs, payload });
  return finalizeExecutiveMasterResult(payload, sourceKind);
}

export async function readExecutiveMasterSheet(
  options?: ExcelReaderOptions
): Promise<ExecutiveMasterSheetReadResult> {
  const sheetName =
    options?.sheetName?.trim() || EXECUTIVE_MASTER_SHEET_NAME;
  const headerRow = options?.headerRow ?? EXECUTIVE_MASTER_HEADER_ROW;

  if (hasExecutiveMasterDriveFileIdConfigured()) {
    try {
      const fromDrive = await readExecutiveMasterSheetFromDriveXlsm({
        sheetName,
        headerRow,
        readerOptions: options,
      });
      const result = finalizeExecutiveMasterResult(fromDrive, "drive");
      console.info(
        `[excel] Executive Master Sheet source=drive rows=${result.rows.length}`
      );
      return result;
    } catch (error) {
      console.warn(
        "[excel] Executive Master Sheet Drive XLSM read failed; falling back to local workbook.",
        error instanceof Error ? error.message : error
      );
    }
  }

  try {
    const fromLocal = await readExecutiveMasterSheetFromLocalFile(options);
    console.info(
      `[excel] Executive Master Sheet source=${fromLocal.sourceKind} rows=${fromLocal.rows.length}`
    );
    return fromLocal;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Executive Master Sheet could not be loaded.";
    throw new Error(message);
  }
}

function sourceUrlFromMeta(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  if (/^https?:\/\//i.test(filePath)) return filePath;
  return undefined;
}

export async function getExecutiveMasterFilterSchema(
  options?: ExcelReaderOptions
): Promise<ExecutiveMasterFilterSchema> {
  const sheet = await readExecutiveMasterSheet(options);
  return {
    sheetName: sheet.sheetName,
    sourceFile: sheet.sourceFile,
    sourceUrl: sourceUrlFromMeta(sheet.meta.filePath),
    sourceKind: sheet.sourceKind,
    headers: [...sheet.headers],
    fields: discoverExecutiveMasterFilters(sheet.headers, sheet.rows),
  };
}

export async function queryExecutiveMasterSheet(
  query: ExecutiveMasterSheetQuery,
  options?: ExcelReaderOptions
): Promise<ExecutiveMasterSheetPageResult> {
  const sheet = await readExecutiveMasterSheet(options);
  const filtered = applyExecutiveMasterFilters(sheet.rows, query);
  const page = paginateExecutiveRows(filtered, query.page, query.pageSize);

  return {
    businessUnitId: "executive",
    sheetName: sheet.sheetName,
    sourceFile: sheet.sourceFile,
    sourceUrl: sourceUrlFromMeta(sheet.meta.filePath),
    sourceKind: sheet.sourceKind,
    headers: [...sheet.headers],
    rows: page.rows,
    total: page.total,
    page: page.page,
    pageSize: page.pageSize as ExecutiveMasterPageSize,
    pageCount: page.pageCount,
    meta: sheet.meta,
  };
}
