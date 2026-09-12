import "server-only";

import { listExecutiveMasterForPDashboard } from "@/services/persistence/read-executive-master";
import type {
  DynamicFilterField,
  DynamicFilterSchema,
} from "@/services/excel/discover-filters";
import type { ExcelOpeningsResult, ExcelReaderOptions } from "@/types/excel";
import type { OpeningsFilters } from "@/types/filters";
import {
  assertExecutivePDashboardContract,
  buildExecutivePDashboardFromRows,
  collectExecutivePDashboardFilterOptions,
  EXECUTIVE_P_DASHBOARD_FILTER_COLUMNS,
  EXECUTIVE_P_DASHBOARD_SHEET_NAME,
  extractExecutivePDashboardFilters,
  groupsToExecutivePDashboardTableRows,
  type ExecutivePDashboardFilterSelection,
  type ExecutivePDashboardGroupRow,
  type ExecutivePDashboardTotals,
} from "@/services/executive-processing/executive-p-dashboard-engine";

export {
  EXECUTIVE_P_DASHBOARD_BLANK_LABEL,
  EXECUTIVE_P_DASHBOARD_FILTER_COLUMNS,
  EXECUTIVE_P_DASHBOARD_LEVEL_COLUMNS,
  EXECUTIVE_P_DASHBOARD_ROW_COLUMNS,
  EXECUTIVE_P_DASHBOARD_SHEET_NAME,
  applyExecutivePDashboardFilters,
  assertExecutivePDashboardContract,
  buildExecutivePDashboardFromRows,
  extractExecutivePDashboardFilters,
  type ExecutivePDashboardFilterSelection,
  type ExecutivePDashboardGroupRow,
  type ExecutivePDashboardTotals,
} from "@/services/executive-processing/executive-p-dashboard-engine";

export interface ExecutivePDashboardResult {
  sheetName: string;
  sourceFile: string;
  sourceLabel: string;
  sourceKind: "postgres";
  headers: string[];
  rows: ExcelOpeningsResult["rows"];
  groups: ExecutivePDashboardGroupRow[];
  totals: ExecutivePDashboardTotals;
  filterOptions: Record<
    (typeof EXECUTIVE_P_DASHBOARD_FILTER_COLUMNS)[number],
    string[]
  >;
  appliedFilters: ExecutivePDashboardFilterSelection;
  meta: {
    filteredDetailCount: number;
    groupCount: number;
    totalRows: number;
  };
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const EXECUTIVE_PG_SOURCE_FILE = "executive_master";
const EXECUTIVE_PG_SOURCE_LABEL =
  "PostgreSQL executive_master → P - Dashboard";

export async function buildExecutivePDashboard(
  columnFilters?: Record<string, string[]>,
  options?: ExcelReaderOptions
): Promise<ExecutivePDashboardResult> {
  void options;
  assertExecutivePDashboardContract();
  const rows = await listExecutiveMasterForPDashboard();
  const appliedFilters = extractExecutivePDashboardFilters(columnFilters);
  const filterOptions = collectExecutivePDashboardFilterOptions(rows);
  const { groups, totals } = buildExecutivePDashboardFromRows(
    rows,
    appliedFilters
  );
  const table = groupsToExecutivePDashboardTableRows(groups, totals);

  return {
    sheetName: EXECUTIVE_P_DASHBOARD_SHEET_NAME,
    sourceFile: EXECUTIVE_PG_SOURCE_FILE,
    sourceLabel: EXECUTIVE_PG_SOURCE_LABEL,
    sourceKind: "postgres",
    headers: table.headers,
    rows: table.rows,
    groups,
    totals,
    filterOptions,
    appliedFilters,
    meta: {
      filteredDetailCount: totals.filteredDetailCount,
      groupCount: groups.length,
      totalRows: rows.length,
    },
  };
}

export async function getExecutivePDashboardFilterSchema(
  options?: ExcelReaderOptions
): Promise<DynamicFilterSchema> {
  void options;
  const rows = await listExecutiveMasterForPDashboard();
  const optionsByColumn = collectExecutivePDashboardFilterOptions(rows);
  const fields: DynamicFilterField[] = EXECUTIVE_P_DASHBOARD_FILTER_COLUMNS.map(
    (column) => ({
      column,
      values: optionsByColumn[column],
      valueCount: optionsByColumn[column].length,
      kind: "categorical" as const,
    })
  );

  return {
    businessUnitId: "executive",
    sheetName: EXECUTIVE_P_DASHBOARD_SHEET_NAME,
    sourceFile: EXECUTIVE_PG_SOURCE_FILE,
    fields,
  };
}

export async function buildExecutivePDashboardOpenings(
  filters?: Partial<OpeningsFilters>,
  options?: ExcelReaderOptions
): Promise<ExcelOpeningsResult> {
  const columnFilters = filters?.columnFilters ?? {};
  const result = await buildExecutivePDashboard(columnFilters, options);

  let rows = result.rows;
  const topN = filters?.topN;
  if (typeof topN === "number" && topN > 0) {
    const body = rows.filter(
      (row) => !/^grand\s*total$/i.test(asText(row["Primary skills"]))
    );
    const totalRow = rows.find((row) =>
      /^grand\s*total$/i.test(asText(row["Primary skills"]))
    );
    const sliced = body.slice(0, topN);
    rows = totalRow ? [...sliced, totalRow] : sliced;
  }

  const sortBy = filters?.sortBy;
  const sortDir = filters?.sortDirection ?? "desc";
  if (sortBy && result.headers.includes(sortBy)) {
    const body = rows.filter(
      (row) => !/^grand\s*total$/i.test(asText(row["Primary skills"]))
    );
    const totalRow = rows.find((row) =>
      /^grand\s*total$/i.test(asText(row["Primary skills"]))
    );
    body.sort((a, b) => {
      const av = a[sortBy];
      const bv = b[sortBy];
      const an = typeof av === "number" ? av : Number(asText(av)) || 0;
      const bn = typeof bv === "number" ? bv : Number(asText(bv)) || 0;
      if (an !== bn) return sortDir === "asc" ? an - bn : bn - an;
      return asText(a["Primary skills"]).localeCompare(
        asText(b["Primary skills"]),
        undefined,
        { sensitivity: "base" }
      );
    });
    rows = totalRow ? [...body, totalRow] : body;
  }

  return {
    businessUnitId: "executive",
    sheetName: result.sheetName,
    sourceFile: result.sourceFile,
    sourceLabel: result.sourceLabel,
    headers: result.headers,
    rows,
    appliedFilters: {
      columnFilters,
      sortBy: filters?.sortBy ?? null,
      sortDirection: filters?.sortDirection ?? "desc",
      topN: filters?.topN ?? null,
    },
    meta: {
      name: result.sheetName,
      rowCount: rows.length,
      columnCount: result.headers.length,
      totalRows: result.meta.totalRows,
      filteredDetailCount: result.meta.filteredDetailCount,
      topN: filters?.topN ?? undefined,
      hasColumnFilters: Object.values(columnFilters).some((v) => v.length > 0),
    },
  };
}
