/**
 * Stage 30A: Lateral processing preview types — matches Next data-reader.ts.
 */

export interface ColumnMapping {
  destinationHeader: string;
  sourceHeader: string;
  sourceColIndex: number;
  destinationColIndex: number;
  generated?: boolean;
}

export interface ColumnMappingFailure {
  ok: false;
  missingDestinationHeaders: string[];
  availableSourceHeaders: string[];
  message?: string;
}

export interface SheetReadResult {
  headers: string[];
  rowCount: number;
  colCount: number;
  previewRows: Array<Record<string, string>>;
}

export interface DataReadPreview {
  ok: true;
  sourceWorkbookName: string;
  sourceWorksheetName: string;
  source: SheetReadResult;
  masterWorkbookName: string;
  masterNewSheetName: string;
  masterNewSheetHeaders: string[];
  columnMappings: ColumnMapping[];
  unmatchedSourceHeaders: string[];
  previewMappedRows: Array<Record<string, string>>;
}

export type DataReadResult = DataReadPreview | ColumnMappingFailure;
