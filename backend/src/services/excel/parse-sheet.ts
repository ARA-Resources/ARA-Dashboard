import type { Worksheet } from "exceljs";
import { normalizeCellValue, toHeaderKey } from "./cell-value.js";

export interface ParsedSheet {
  sheetName: string;
  headerRow: number;
  headers: string[];
  rows: Record<string, string | number | null>[];
}

function getRowCells(
  sheet: Worksheet,
  rowNumber: number,
  maxCol: number
): Array<string | number | null> {
  const row = sheet.getRow(rowNumber);
  const cells: Array<string | number | null> = [];
  for (let col = 1; col <= maxCol; col += 1) {
    cells.push(normalizeCellValue(row.getCell(col).value));
  }
  return cells;
}

function scoreHeaderCandidate(cells: Array<string | number | null>) {
  const meaningful = cells.filter((cell) => {
    if (typeof cell !== "string") return false;
    if (!cell.trim()) return false;
    if (/^\(All\)$/i.test(cell)) return false;
    if (/^\(Multiple/i.test(cell)) return false;
    return true;
  });
  return meaningful.length;
}

export function detectHeaderRow(sheet: Worksheet, maxScan = 30): number {
  const maxCol = Math.max(sheet.columnCount || 0, 1);
  const scanTo = Math.min(maxScan, sheet.rowCount || 1);
  let bestRow = 1;
  let bestScore = -1;

  for (let row = 1; row <= scanTo; row += 1) {
    const score = scoreHeaderCandidate(getRowCells(sheet, row, maxCol));
    if (score > bestScore) {
      bestScore = score;
      bestRow = row;
    }
  }

  return bestRow;
}

function isSummaryLabel(value: string | number | null) {
  if (typeof value !== "string") return false;
  return /^grand\s*total$/i.test(value.trim());
}

export function parseWorksheet(
  sheet: Worksheet,
  options?: { headerRow?: number }
): ParsedSheet {
  const maxCol = Math.max(sheet.columnCount || 0, 1);
  const headerRow = options?.headerRow ?? detectHeaderRow(sheet);
  const headerCells = getRowCells(sheet, headerRow, maxCol);

  const used = new Set<string>();
  const headers: string[] = [];
  const headerIndexes: number[] = [];

  headerCells.forEach((cell, index) => {
    if (cell === null || cell === "") return;
    const label = String(cell);
    headers.push(toHeaderKey(label, index, used));
    headerIndexes.push(index);
  });

  if (headers.length === 0) {
    return {
      sheetName: sheet.name,
      headerRow,
      headers: [],
      rows: [],
    };
  }

  const rows: Record<string, string | number | null>[] = [];

  for (
    let rowNumber = headerRow + 1;
    rowNumber <= (sheet.rowCount || 0);
    rowNumber += 1
  ) {
    const cells = getRowCells(sheet, rowNumber, maxCol);
    const record: Record<string, string | number | null> = {};
    let hasValue = false;

    headerIndexes.forEach((cellIndex, headerIndex) => {
      const value = cells[cellIndex] ?? null;
      record[headers[headerIndex]] = value;
      if (value !== null && value !== "") hasValue = true;
    });

    if (!hasValue) continue;

    const firstValue = record[headers[0]];
    if (isSummaryLabel(firstValue)) continue;

    rows.push(record);
  }

  return {
    sheetName: sheet.name,
    headerRow,
    headers,
    rows,
  };
}
