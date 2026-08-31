import { readExecutiveMasterSheet } from "./read-executive-master-sheet.js";
import type {
  DynamicFilterField,
  DynamicFilterSchema,
} from "./discover-filters.js";
import type { ExcelOpeningsResult, ExcelReaderOptions } from "../../types/excel.js";
import type { OpeningsFilters } from "../../types/filters.js";
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
} from "./executive-p-dashboard-engine.js";

export interface ExecutivePDashboardResult {
  sheetName: string;
  sourceFile: string;
  sourceLabel: string;
  sourceKind: "drive" | "local" | "bundled";
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

export async function buildExecutivePDashboard(
  columnFilters?: Record<string, string[]>,
  options?: ExcelReaderOptions
): Promise<ExecutivePDashboardResult> {
  assertExecutivePDashboardContract();
  const sheet = await readExecutiveMasterSheet(options);
  const appliedFilters = extractExecutivePDashboardFilters(columnFilters);
  const filterOptions = collectExecutivePDashboardFilterOptions(sheet.rows);
  const { groups, totals } = buildExecutivePDashboardFromRows(
    sheet.rows,
    appliedFilters
  );
  const table = groupsToExecutivePDashboardTableRows(groups, totals);

  return {
    sheetName: EXECUTIVE_P_DASHBOARD_SHEET_NAME,
    sourceFile: sheet.sourceFile,
    sourceLabel: `${sheet.sourceLabel} · Master Sheet → P - Dashboard`,
    sourceKind: sheet.sourceKind,
    headers: table.headers,
    rows: table.rows,
    groups,
    totals,
    filterOptions,
    appliedFilters,
    meta: {
      filteredDetailCount: totals.filteredDetailCount,
      groupCount: groups.length,
      totalRows: sheet.rows.length,
    },
  };
}

export async function getExecutivePDashboardFilterSchema(
  options?: ExcelReaderOptions
): Promise<DynamicFilterSchema> {
  const sheet = await readExecutiveMasterSheet(options);
  const optionsByColumn = collectExecutivePDashboardFilterOptions(sheet.rows);
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
    sheetName: sheet.sheetName,
    sourceFile: sheet.sourceFile,
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
