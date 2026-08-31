import ExcelJS from "exceljs";
import { CONSULTING_EXCEL_SOURCE } from "../../constants/consulting.js";
import { ensureConsultingDataset } from "../dataset/seed-current.js";
import type { ExcelReadResult, ExcelReaderOptions } from "../../types/excel.js";
import { parseWorksheet } from "./parse-sheet.js";

interface CacheEntry {
  mtimeMs: number;
  payload: ExcelReadResult;
}

const workbookCache = new Map<string, CacheEntry>();

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

function resolveWorksheet(
  workbook: ExcelJS.Workbook,
  preferredSheetName: string
) {
  const preferred = findSheet(workbook, preferredSheetName);
  if (preferred) return preferred;

  const fallbackNames = ["Sheet1"];
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

/**
 * Read Consulting primary sheet from Dataset Manager current workbook.
 */
export async function readConsultingSheet(
  options?: ExcelReaderOptions
): Promise<ExcelReadResult> {
  const dataset = await ensureConsultingDataset();
  const filePath = dataset.filePath;
  const mtimeMs = dataset.mtimeMs;
  const sourceLabel = dataset.fileName;
  const sheetName = options?.sheetName ?? CONSULTING_EXCEL_SOURCE.primarySheet;
  const headerRow = options?.headerRow ?? CONSULTING_EXCEL_SOURCE.headerRow;

  const cacheKey = `consulting:${sheetName}:${filePath}`;
  const cached = workbookCache.get(cacheKey);
  if (cached && cached.mtimeMs === mtimeMs && !options?.bypassCache) {
    return cached.payload;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = resolveWorksheet(workbook, sheetName);

  if (!worksheet) {
    const available = workbook.worksheets.map((sheet) => sheet.name).join(", ");
    throw new Error(
      `Sheet "${sheetName}" not found in Dataset Manager file ${sourceLabel}. Available: ${available}`
    );
  }

  const resolvedHeaderRow =
    worksheet.name.trim().toLowerCase() === sheetName.trim().toLowerCase()
      ? headerRow
      : 1;

  const parsed = parseWorksheet(worksheet, {
    headerRow: resolvedHeaderRow,
  });

  const payload: ExcelReadResult = {
    businessUnitId: "consulting",
    sheetName: parsed.sheetName,
    sourceFile: sourceLabel,
    sourceLabel,
    headers: parsed.headers,
    rows: parsed.rows.map((row, index) => ({
      id: `consulting-${parsed.sheetName}-${index + 1}`,
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

export function clearConsultingExcelCache(): void {
  workbookCache.clear();
}
