import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  assertExecutiveMasterHeaders,
  applyExecutiveMasterFilters,
  discoverExecutiveMasterFilters,
  EXECUTIVE_MASTER_HEADER_ROW,
  EXECUTIVE_MASTER_SHEET_NAME,
  paginateExecutiveRows,
  projectExecutiveMasterLiveColumns,
  type ExecutiveMasterDataSourceKind,
  type ExecutiveMasterFilterSchema,
  type ExecutiveMasterPageSize,
  type ExecutiveMasterSheetPageResult,
  type ExecutiveMasterSheetQuery,
  type ExecutiveMasterSheetReadResult,
} from "@/services/excel/executive-master-sheet";
import {
  hasExecutiveMasterDriveFileIdConfigured,
  readExecutiveMasterSheetFromDriveXlsm,
} from "@/services/excel/read-executive-master-from-drive-xlsm";
import { buildMasterSheetXlsxBuffer } from "@/services/excel/build-master-sheet-xlsx";
import { parseWorksheet } from "@/services/excel/parse-sheet";
import { resolveReadableExcelPath } from "@/services/excel/readable-workbook";
import {
  assertConfiguredExecutiveExcelPath,
  getBundledExecutiveExcelPath,
  getExecutiveExcelPath,
} from "@/lib/config/runtime";
import type { ExcelReadResult, ExcelReaderOptions } from "@/types/excel";

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

/**
 * Read Master Sheet from a local / bundled Executive XLSM path.
 */
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
      // Never expose absolute local paths in API-facing meta.
      filePath: undefined,
      mtimeMs,
      totalRows: parsed.rows.length,
    },
  };

  localMemoryCache.set(cacheKey, { mtimeMs, payload });
  return finalizeExecutiveMasterResult(payload, sourceKind);
}

/**
 * Unified Executive Master Sheet reader.
 *
 * Priority:
 * 1. Google Drive when ARA_EXECUTIVE_MASTER_DRIVE_FILE_ID is set
 * 2. Local ARA_EXECUTIVE_EXCEL_PATH
 * 3. Bundled data/excel/executive-mastersheet.xlsm
 */
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

/**
 * Focused validation helper for Phase 2A / scripts.
 * Does not print paths, Drive IDs, or secrets.
 */
export async function validateExecutiveMasterSheetRead(
  options?: ExcelReaderOptions
): Promise<{
  ok: boolean;
  sourceKind: ExecutiveMasterDataSourceKind;
  sheetName: string;
  headerRow: number;
  headerCount: number;
  rowCount: number;
  jobStatusValues: string[];
  postedValues: string[];
  prioritySample: string[];
  levelSample: string[];
  hasJobDescription: boolean;
  hasMustHaveSkills: boolean;
  issues: string[];
}> {
  const sheet = await readExecutiveMasterSheet({
    ...options,
    bypassCache: true,
  });
  const issues: string[] = [];

  if (sheet.sheetName.trim().toLowerCase() !== "master sheet") {
    issues.push(`Unexpected sheet name: ${sheet.sheetName}`);
  }
  if (sheet.meta.headerRow !== 1) {
    issues.push(`Unexpected headerRow: ${sheet.meta.headerRow}`);
  }
  if (sheet.headers.length !== 23) {
    issues.push(`Expected 23 live headers, got ${sheet.headers.length}`);
  }
  if (sheet.rows.length === 0) {
    issues.push("No data rows");
  }

  const status = new Set<string>();
  const posted = new Set<string>();
  const priority = new Set<string>();
  const levels = new Set<string>();
  let hasJd = false;
  let hasMust = false;
  let hasJr = false;

  for (const row of sheet.rows) {
    const jr = row["Job Requisition ID"];
    if (jr !== null && jr !== undefined && String(jr).trim()) hasJr = true;
    const st = row["Job Status"];
    if (st !== null && st !== undefined && String(st).trim()) {
      status.add(String(st));
    }
    const po = row["Posted"];
    if (po !== null && po !== undefined && String(po).trim()) {
      posted.add(String(po));
    }
    const pr = row["Priority"];
    if (pr !== null && pr !== undefined && String(pr).trim()) {
      priority.add(String(pr));
    }
    const lv = row["Level"];
    if (lv !== null && lv !== undefined && String(lv).trim()) {
      levels.add(String(lv));
    }
    if (row["Job Description"]) hasJd = true;
    if (row["Must Have skills"]) hasMust = true;
  }

  if (!hasJr) issues.push("Job Requisition ID not readable");
  if (!hasJd) issues.push("Job Description not readable");
  if (!status.has("Active") || !status.has("Closed")) {
    issues.push("Expected Job Status values Active and Closed");
  }
  if (!posted.has("Yes") || !posted.has("-")) {
    issues.push('Expected Posted values Yes and "-"');
  }
  for (const needed of [
    "5-Associate Director",
    "6-Senior Manager",
    "7-Manager",
  ]) {
    if (![...levels].includes(needed)) {
      issues.push(`Expected Level value ${needed}`);
    }
  }

  return {
    ok: issues.length === 0,
    sourceKind: sheet.sourceKind,
    sheetName: sheet.sheetName,
    headerRow: sheet.meta.headerRow,
    headerCount: sheet.headers.length,
    rowCount: sheet.rows.length,
    jobStatusValues: [...status].sort(),
    postedValues: [...posted].sort(),
    prioritySample: [...priority].sort().slice(0, 12),
    levelSample: [...levels].sort(),
    hasJobDescription: hasJd,
    hasMustHaveSkills: hasMust,
    issues,
  };
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

/**
 * Export the entire live A–W Master Sheet as .xlsx.
 * Dashboard UI filters are ignored so Excel receives the full table (Lateral parity).
 */
export async function exportExecutiveMasterSheetXlsx(
  options?: ExcelReaderOptions
): Promise<{
  buffer: Buffer;
  fileName: string;
  rowCount: number;
  sheetName: string;
}> {
  const sheet = await readExecutiveMasterSheet(options);
  const buffer = await buildMasterSheetXlsxBuffer({
    sheetName: sheet.sheetName || EXECUTIVE_MASTER_SHEET_NAME,
    headers: [...sheet.headers],
    rows: sheet.rows,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return {
    buffer,
    fileName: `Executive-Master-Sheet-${stamp}.xlsx`,
    rowCount: sheet.rows.length,
    sheetName: sheet.sheetName || EXECUTIVE_MASTER_SHEET_NAME,
  };
}
