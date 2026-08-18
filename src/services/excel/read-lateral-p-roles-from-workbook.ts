import ExcelJS from "exceljs";
import { normalizeCellValue } from "@/services/excel/cell-value";
import { parseWorksheet } from "@/services/excel/parse-sheet";
import { resolveReadableExcelPath } from "@/services/excel/readable-workbook";
import {
  buildPRolesDashboardHeaders,
  LATERAL_P_ROLES_SHEET_TITLE,
} from "@/services/excel/read-lateral-p-roles-from-google";
import { statLateralReferenceWorkbook } from "@/services/excel/lateral-reference-workbook";
import type { ExcelCellValue, ExcelDataRow, ExcelReadResult, ExcelReaderOptions } from "@/types/excel";

const LATERAL_MASTER_SHEET_TITLE = "Master Sheet";

interface CacheEntry {
  mtimeMs: number;
  payload: ExcelReadResult;
}

const cache = new Map<string, CacheEntry>();

function cellToValue(raw: unknown): ExcelCellValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw;
  const s = String(raw).replace(/\u00a0/g, " ").trim();
  if (!s) return null;
  const asNum = Number(s.replace(/,/g, ""));
  if (Number.isFinite(asNum) && /^-?\d[\d,]*(\.\d+)?$/.test(s)) {
    return asNum;
  }
  return s;
}

function worksheetToGrid(sheet: ExcelJS.Worksheet): string[][] {
  const maxRow = Math.max(sheet.rowCount || 0, 1);
  const maxCol = Math.max(sheet.columnCount || 0, 26);
  const grid: string[][] = [];

  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const line: string[] = [];
    for (let col = 1; col <= maxCol; col += 1) {
      const value = normalizeCellValue(row.getCell(col).value);
      line.push(value === null ? "" : String(value));
    }
    grid.push(line);
  }

  return grid;
}

/**
 * Company → Accenture → Dashboard reads P-Roles from the local reference XLSM.
 */
export async function readLateralPRolesFromReferenceWorkbook(
  options?: ExcelReaderOptions
): Promise<ExcelReadResult> {
  const { filePath, fileName, mtimeMs } = await statLateralReferenceWorkbook();
  const cacheKey = filePath;
  const cached = cache.get(cacheKey);
  if (cached && cached.mtimeMs === mtimeMs && !options?.bypassCache) {
    return cached.payload;
  }

  const readablePath = await resolveReadableExcelPath(filePath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(readablePath);

  const sheet =
    workbook.getWorksheet(LATERAL_P_ROLES_SHEET_TITLE) ??
    workbook.worksheets.find(
      (item) =>
        item.name.trim().toLowerCase() ===
        LATERAL_P_ROLES_SHEET_TITLE.toLowerCase()
    ) ??
    null;

  if (!sheet) {
    const available = workbook.worksheets.map((item) => item.name).join(", ");
    throw new Error(
      `Sheet "${LATERAL_P_ROLES_SHEET_TITLE}" not found in ${fileName}. Available: ${available}`
    );
  }

  const grid = worksheetToGrid(sheet);
  const { headerRowIndex, headers } = buildPRolesDashboardHeaders(grid);
  const cleanHeaders = headers.filter(Boolean);
  const rows: ExcelDataRow[] = [];

  for (let r = headerRowIndex + 1; r < grid.length; r += 1) {
    const line = grid[r] || [];
    const obj: ExcelDataRow = { id: `p-roles-xlsm-${r + 1}` };
    let any = false;
    for (let c = 0; c < headers.length; c += 1) {
      const key = headers[c];
      if (!key) continue;
      const value = cellToValue(line[c]);
      obj[key] = value;
      if (value !== null && value !== "") any = true;
    }
    if (!any) continue;

    const skill = String(obj["Primary Skills"] ?? "").trim();
    if (/^grand\s*total$/i.test(skill)) continue;

    const clean: ExcelDataRow = { id: obj.id };
    for (const header of cleanHeaders) {
      clean[header] = obj[header] ?? null;
    }
    rows.push(clean);
  }

  const payload: ExcelReadResult = {
    businessUnitId: "lateral",
    sheetName: LATERAL_P_ROLES_SHEET_TITLE,
    sourceFile: fileName,
    sourceLabel: `Reference workbook · ${fileName} · ${LATERAL_P_ROLES_SHEET_TITLE}`,
    headers: cleanHeaders,
    rows,
    meta: {
      name: LATERAL_P_ROLES_SHEET_TITLE,
      rowCount: rows.length,
      columnCount: cleanHeaders.length,
      headerRow: headerRowIndex + 1,
      filePath,
      mtimeMs,
      totalRows: rows.length,
    },
  };

  cache.set(cacheKey, { mtimeMs, payload });
  return payload;
}

/**
 * Master Sheet from the same reference XLSM — used for dashboard filters
 * (Job Status, Posted, Market Map) before aggregating to a P-Roles-style table.
 */
export async function readLateralMasterFromReferenceWorkbook(
  options?: ExcelReaderOptions
): Promise<ExcelReadResult> {
  const { filePath, fileName, mtimeMs } = await statLateralReferenceWorkbook();
  const cacheKey = `${filePath}::master`;
  const cached = cache.get(cacheKey);
  if (cached && cached.mtimeMs === mtimeMs && !options?.bypassCache) {
    return cached.payload;
  }

  const readablePath = await resolveReadableExcelPath(filePath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(readablePath);

  const sheet =
    workbook.getWorksheet(LATERAL_MASTER_SHEET_TITLE) ??
    workbook.worksheets.find(
      (item) =>
        item.name.trim().toLowerCase() ===
        LATERAL_MASTER_SHEET_TITLE.toLowerCase()
    ) ??
    null;

  if (!sheet) {
    const available = workbook.worksheets.map((item) => item.name).join(", ");
    throw new Error(
      `Sheet "${LATERAL_MASTER_SHEET_TITLE}" not found in ${fileName}. Available: ${available}`
    );
  }

  const parsed = parseWorksheet(sheet, {
    headerRow: options?.headerRow ?? 1,
  });

  const payload: ExcelReadResult = {
    businessUnitId: "lateral",
    sheetName: parsed.sheetName,
    sourceFile: fileName,
    sourceLabel: `Reference workbook · ${fileName} · ${parsed.sheetName}`,
    headers: parsed.headers,
    rows: parsed.rows.map((row, index) => ({
      id: `master-xlsm-${parsed.sheetName}-${index + 1}`,
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

  cache.set(cacheKey, { mtimeMs, payload });
  return payload;
}
