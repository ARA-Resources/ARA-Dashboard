import type { OpeningsFilters } from "./filters.js";

export interface ExcelSheetMeta {
  name: string;
  rowCount: number;
  columnCount: number;
  headerRow?: number;
  filePath?: string;
  mtimeMs?: number;
  totalRows?: number;
  topN?: number;
  filteredDetailCount?: number;
  hasColumnFilters?: boolean;
}

export type ExcelCellValue = string | number | null;

export type ExcelDataRow = {
  id: string;
  [column: string]: ExcelCellValue;
};

export interface ExcelReadResult {
  businessUnitId: "consulting";
  sheetName: string;
  sourceFile: string;
  sourceLabel: string;
  headers: string[];
  rows: ExcelDataRow[];
  meta: ExcelSheetMeta;
}

export interface ExcelOpeningsResult extends ExcelReadResult {
  appliedFilters?: OpeningsFilters;
  meta: ExcelSheetMeta & {
    totalRows?: number;
    topN?: number;
    filteredDetailCount?: number;
  };
}

export interface ExcelReaderOptions {
  sheetName?: string;
  headerRow?: number;
  bypassCache?: boolean;
}
