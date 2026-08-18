import ExcelJS from "exceljs";
import {
  getExcelSource,
  resolveDatasetExcel,
} from "@/services/excel/registry";
import { parseWorksheet } from "@/services/excel/parse-sheet";
import { aggregateOpeningsFromDetail } from "@/services/excel/aggregate-openings";
import {
  applyColumnFilters,
  applySortAndTopN,
} from "@/services/excel/apply-filters";
import {
  createBaseOpeningsFilters,
  resolveDefaultsFromSchema,
} from "@/constants/default-filters";
import { discoverFilterFields } from "@/services/excel/discover-filters";
import { resolveReadableExcelPath } from "@/services/excel/readable-workbook";
import {
  LATERAL_P_ROLES_SHEET_TITLE,
  readLateralPRolesFromGoogleSpreadsheet,
  resolveLateralPRolesGoogleSpreadsheetId,
} from "@/services/excel/read-lateral-p-roles-from-google";
import {
  getLateralProcessingMasterDriveFileId,
  readLateralMasterSheetFromDriveXlsm,
} from "@/services/excel/read-lateral-master-from-drive-xlsm";
import type { BusinessUnitId } from "@/types/business-unit";
import type { OpeningsFilters } from "@/types/filters";
import type {
  ExcelOpeningsResult,
  ExcelReadResult,
  ExcelReaderOptions,
} from "@/types/excel";

const LATERAL_MASTER_SHEET_TITLE = "Master Sheet";

interface CacheEntry {
  mtimeMs: number;
  payload: ExcelReadResult;
}

const workbookCache = new Map<string, CacheEntry>();

async function loadWorkbook(filePath: string) {
  const readablePath = await resolveReadableExcelPath(filePath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(readablePath);
  return workbook;
}

function findSheet(workbook: ExcelJS.Workbook, sheetName: string) {
  const exact = workbook.getWorksheet(sheetName);
  if (exact) return exact;

  const normalized = sheetName.trim().toLowerCase();
  return (
    workbook.worksheets.find(
      (sheet) => sheet.name.trim().toLowerCase() === normalized
    ) ?? null
  );
}

/** Prefer configured sheet; otherwise pick the richest data sheet in synced workbooks. */
function resolveWorksheet(
  workbook: ExcelJS.Workbook,
  preferredSheetName: string
) {
  const preferred = findSheet(workbook, preferredSheetName);
  if (preferred) return preferred;

  const fallbackNames = [
    "Master Sheet",
    "ATCI DS",
    "Base DS",
    "GCC DS",
    "Sheet1",
  ];
  for (const name of fallbackNames) {
    const sheet = findSheet(workbook, name);
    if (sheet && sheet.rowCount > 1) return sheet;
  }

  return (
    [...workbook.worksheets]
      .filter((sheet) => sheet.rowCount > 1)
      .sort((a, b) => b.rowCount - a.rowCount)[0] ?? null
  );
}

async function readSheetFromFile(
  businessUnitId: BusinessUnitId,
  sheetName: string,
  headerRow: number | undefined,
  options?: ExcelReaderOptions
): Promise<ExcelReadResult> {
  const normalizedSheet = sheetName.trim().toLowerCase();

  // Lateral dashboard filters + aggregation: Drive XLSM Master Sheet ONLY (primary).
  // Do not fall back to Dropbox "Reference workbook" — that masks the live source.
  if (
    businessUnitId === "lateral" &&
    normalizedSheet === LATERAL_MASTER_SHEET_TITLE.toLowerCase()
  ) {
    return readLateralMasterSheetFromDriveXlsm({
      sheetName: LATERAL_MASTER_SHEET_TITLE,
      headerRow: options?.headerRow ?? headerRow ?? 1,
      readerOptions: options,
    });
  }

  // Lateral P-Roles pivot tab — Drive XLSM first, then Google Sheet (no Dropbox).
  if (
    businessUnitId === "lateral" &&
    normalizedSheet === LATERAL_P_ROLES_SHEET_TITLE.toLowerCase()
  ) {
    try {
      return await readLateralMasterSheetFromDriveXlsm({
        sheetName: LATERAL_P_ROLES_SHEET_TITLE,
        headerRow: options?.headerRow ?? 6,
        readerOptions: options,
      });
    } catch (error) {
      console.warn(
        `[excel] Lateral P-Roles Drive XLSM (${getLateralProcessingMasterDriveFileId()}) read failed; trying Google Sheet.`,
        error instanceof Error ? error.message : error
      );
    }

    const googleId = await resolveLateralPRolesGoogleSpreadsheetId();
    if (googleId) {
      try {
        return await readLateralPRolesFromGoogleSpreadsheet({
          spreadsheetId: googleId,
          bypassCache: options?.bypassCache,
        });
      } catch (error) {
        console.warn(
          "[excel] Lateral P-Roles Google Sheet read failed; falling back to Dataset Manager workbook.",
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  let dataset;
  try {
    dataset = await resolveDatasetExcel(businessUnitId);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : `Dataset not found for ${businessUnitId}.`;
    throw new Error(message);
  }

  const filePath = dataset.filePath;
  const mtimeMs = dataset.mtimeMs;
  const sourceLabel = dataset.fileName;

  const cacheKey = `${businessUnitId}:${sheetName}:${filePath}`;
  const cached = workbookCache.get(cacheKey);
  if (cached && cached.mtimeMs === mtimeMs && !options?.bypassCache) {
    return cached.payload;
  }

  const workbook = await loadWorkbook(filePath);
  const worksheet = resolveWorksheet(workbook, sheetName);

  if (!worksheet) {
    const available = workbook.worksheets.map((sheet) => sheet.name).join(", ");
    throw new Error(
      `Sheet "${sheetName}" not found in Dataset Manager file ${sourceLabel}. Available: ${available}`
    );
  }

  // Synced vendor DS sheets use row 1 headers even when Master Sheet config differs.
  const resolvedHeaderRow =
    worksheet.name.trim().toLowerCase() === sheetName.trim().toLowerCase()
      ? (options?.headerRow ?? headerRow)
      : (options?.headerRow ?? 1);

  const parsed = parseWorksheet(worksheet, {
    headerRow: resolvedHeaderRow,
  });

  const payload: ExcelReadResult = {
    businessUnitId,
    sheetName: parsed.sheetName,
    sourceFile: sourceLabel,
    sourceLabel,
    headers: parsed.headers,
    rows: parsed.rows.map((row, index) => ({
      id: `${businessUnitId}-${parsed.sheetName}-${index + 1}`,
      ...row,
    })),
    meta: {
      name: parsed.sheetName,
      rowCount: parsed.rows.length,
      columnCount: parsed.headers.length,
      headerRow: parsed.headerRow,
      filePath,
      mtimeMs,
    },
  };

  workbookCache.set(cacheKey, { mtimeMs, payload });
  return payload;
}

/**
 * Read a named sheet from the Lateral Dataset Manager current workbook.
 * Used by the Lateral Master Sheet page (not the Accenture Dashboard P-Roles view).
 */
export async function readSheetFromFileForLateralMaster(
  sheetName: string,
  headerRow: number | undefined,
  options?: ExcelReaderOptions
): Promise<ExcelReadResult> {
  return readSheetFromFile("lateral", sheetName, headerRow, options);
}

/**
 * Sheet used for dynamic filters (detail sheet when present, else primary).
 */
export async function readFilterSourceSheet(
  businessUnitId: BusinessUnitId,
  options?: ExcelReaderOptions
): Promise<ExcelReadResult> {
  const source = getExcelSource(businessUnitId);
  const sheetName = source.detailSheet ?? source.primarySheet;
  const headerRow = source.detailSheet
    ? (source.detailHeaderRow ?? 1)
    : source.headerRow;
  return readSheetFromFile(businessUnitId, sheetName, headerRow, options);
}

/**
 * Read a business unit's primary Excel sheet with ExcelJS.
 */
export async function readBusinessUnitSheet(
  businessUnitId: BusinessUnitId,
  options?: ExcelReaderOptions
): Promise<ExcelReadResult> {
  const source = getExcelSource(businessUnitId);
  const sheetName = options?.sheetName ?? source.primarySheet;
  return readSheetFromFile(
    businessUnitId,
    sheetName,
    source.headerRow,
    options
  );
}

function resolveFilters(
  businessUnitId: BusinessUnitId,
  filters?: Partial<OpeningsFilters>
): OpeningsFilters {
  const base = createBaseOpeningsFilters(businessUnitId);
  if (!filters) return base;
  return {
    columnFilters: filters.columnFilters ?? base.columnFilters,
    sortBy: filters.sortBy === undefined ? base.sortBy : filters.sortBy,
    sortDirection: filters.sortDirection ?? base.sortDirection,
    topN: filters.topN === undefined ? base.topN : filters.topN,
  };
}

function hasColumnFilters(columnFilters: Record<string, string[]>) {
  return Object.values(columnFilters).some((values) => values.length > 0);
}

/**
 * Filtered + ranked openings for the Accenture dashboard table.
 */
export async function readTopOpenings(
  businessUnitId: BusinessUnitId,
  filters?: Partial<OpeningsFilters>,
  options?: ExcelReaderOptions
): Promise<ExcelOpeningsResult> {
  const source = getExcelSource(businessUnitId);
  const resolved = resolveFilters(businessUnitId, filters);

  let headers: string[];
  let rows: ExcelReadResult["rows"];
  let sheetName: string;
  let baseMeta: ExcelReadResult["meta"];
  let sourceFile: string;
  let sourceLabel: string;
  let filteredDetailCount: number | undefined;

  if (source.detailSheet) {
    const detail = await readFilterSourceSheet(businessUnitId, options);
    const filtered = applyColumnFilters(detail.rows, resolved.columnFilters);
    filteredDetailCount = filtered.length;
    const aggregated = aggregateOpeningsFromDetail(
      businessUnitId,
      detail.headers,
      filtered
    );
    headers = aggregated.headers;
    rows = aggregated.rows;
    sheetName = `${detail.sheetName} → aggregated`;
    baseMeta = detail.meta;
    sourceFile = detail.sourceFile;
    sourceLabel = detail.sourceLabel;
  } else {
    const full = await readBusinessUnitSheet(businessUnitId, options);
    const filtered = applyColumnFilters(full.rows, resolved.columnFilters);
    filteredDetailCount = filtered.length;
    headers = full.headers;
    rows = filtered;
    sheetName = full.sheetName;
    baseMeta = full.meta;
    sourceFile = full.sourceFile;
    sourceLabel = full.sourceLabel;
  }

  // If sortBy still null, try resolving Grand Total from result headers
  if (!resolved.sortBy) {
    const defaults = resolveDefaultsFromSchema(
      businessUnitId,
      {
        businessUnitId,
        sheetName,
        sourceFile,
        fields: discoverFilterFields(headers, rows),
      },
      headers
    );
    if (defaults.sortBy) resolved.sortBy = defaults.sortBy;
  }

  const ranked = applySortAndTopN(headers, rows, resolved).map((row, index) => ({
    ...row,
    id: String(row.id ?? `${businessUnitId}-top-${index + 1}`),
  }));

  return {
    businessUnitId,
    sheetName,
    sourceFile,
    sourceLabel,
    headers,
    rows: ranked,
    appliedFilters: resolved,
    meta: {
      ...baseMeta,
      name: sheetName,
      rowCount: ranked.length,
      columnCount: headers.length,
      totalRows: rows.length,
      filteredDetailCount,
      topN: resolved.topN ?? undefined,
      hasColumnFilters: hasColumnFilters(resolved.columnFilters),
    },
  };
}

export function clearExcelCache() {
  workbookCache.clear();
}
