export type SortDirection = "asc" | "desc";

export type OpeningsFilters = {
  columnFilters: Record<string, string[]>;
  sortBy: string | null;
  sortDirection: SortDirection;
  topN: number | null;
};

export type ExcelCellValue = string | number | null;

export type ExcelDataRow = {
  id: string;
  [column: string]: ExcelCellValue;
};

export type ExcelOpeningsResult = {
  businessUnitId: "lateral";
  sheetName: string;
  sourceFile: string;
  sourceLabel: string;
  headers: string[];
  rows: ExcelDataRow[];
  appliedFilters?: OpeningsFilters;
  meta: {
    name: string;
    rowCount: number;
    columnCount: number;
    headerRow: number;
    filePath?: string;
    mtimeMs?: number;
    totalRows?: number;
    filteredDetailCount?: number;
    topN?: number;
    hasColumnFilters?: boolean;
  };
};

export type PRolesMasterRow = {
  jobRequisitionId: string;
  primarySkills: string;
  skillCategorization: string;
  jobManagementLevel: string;
  jobStatus: string;
  posted: string;
  marketMap: string;
};
