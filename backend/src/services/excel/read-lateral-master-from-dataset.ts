/**
 * Dataset Manager fallback for Lateral Master Sheet reads.
 * Mirrors Next readSheetFromFile / readSheetFromFileForLateralMaster behavior.
 */
import ExcelJS from "exceljs";
import type { ExcelReadResult, ExcelReaderOptions } from "../../types/excel.js";
import { resolveCurrentDatasetFile } from "../dataset/resolve-current.js";
import { parseWorksheet } from "./parse-sheet.js";
import { readLateralMasterSheetFromDriveXlsm } from "./read-lateral-master-from-drive-xlsm.js";
import { resolveReadableExcelPath } from "./readable-workbook.js";

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

function resolveWorksheet(workbook: ExcelJS.Workbook, preferredSheetName: string) {
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

async function ensureLateralDataset() {
  const current = await resolveCurrentDatasetFile("Lateral");
  if (current) return current;
  throw new Error(
    "No synchronized dataset for Lateral. Open Dataset Manager and sync the latest Lateral Excel file."
  );
}

async function readSheetFromFile(
  sheetName: string,
  headerRow: number | undefined,
  options?: ExcelReaderOptions
): Promise<ExcelReadResult> {
  const normalizedSheet = sheetName.trim().toLowerCase();

  if (normalizedSheet === LATERAL_MASTER_SHEET_TITLE.toLowerCase()) {
    return readLateralMasterSheetFromDriveXlsm({
      sheetName: LATERAL_MASTER_SHEET_TITLE,
      headerRow: options?.headerRow ?? headerRow ?? 1,
      readerOptions: options,
    });
  }

  const dataset = await ensureLateralDataset();
  const filePath = dataset.filePath;
  const mtimeMs = dataset.mtimeMs;
  const sourceLabel = dataset.fileName;

  const cacheKey = `lateral:${sheetName}:${filePath}`;
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

  const resolvedHeaderRow =
    worksheet.name.trim().toLowerCase() === sheetName.trim().toLowerCase()
      ? (options?.headerRow ?? headerRow)
      : (options?.headerRow ?? 1);

  const parsed = parseWorksheet(worksheet, {
    headerRow: resolvedHeaderRow ?? 1,
  });

  const payload: ExcelReadResult = {
    businessUnitId: "lateral",
    sheetName: parsed.sheetName,
    sourceFile: sourceLabel,
    sourceLabel,
    headers: parsed.headers,
    rows: parsed.rows.map((row, index) => ({
      id: `lateral-${parsed.sheetName}-${index + 1}`,
      ...row,
    })),
    meta: {
      name: parsed.sheetName,
      rowCount: parsed.rows.length,
      columnCount: parsed.headers.length,
      headerRow: parsed.headerRow,
      filePath,
      mtimeMs,
      totalRows: parsed.rows.length,
    },
  };

  workbookCache.set(cacheKey, { mtimeMs, payload });
  return payload;
}

export async function readLateralMasterSheetFromDatasetFile(
  sheetName: string,
  headerRow: number | undefined,
  options?: ExcelReaderOptions
): Promise<ExcelReadResult> {
  return readSheetFromFile(sheetName, headerRow, options);
}
