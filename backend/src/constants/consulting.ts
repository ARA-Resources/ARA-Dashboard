import type { OpeningsFilters } from "../types/filters.js";

/** Consulting Excel layout — file bytes come from Dataset Manager. */
export const CONSULTING_EXCEL_SOURCE = {
  fileName: "consulting-demand.xlsx",
  relativePath: "data/excel/consulting-demand.xlsx",
  primarySheet: "Sheet1",
  sourceLabel: "Consulting Dataset (Dataset Manager)",
  headerRow: 1,
} as const;

export const CONSULTING_FILTER_DEFAULTS = {
  sortByPatterns: [] as RegExp[],
  sortDirection: "desc" as const,
  topN: 10,
  preferredStatusValues: ["Active", "New"],
  preferredPostedValues: ["Yes"],
};

export function createBaseConsultingFilters(): OpeningsFilters {
  return {
    columnFilters: {},
    sortBy: null,
    sortDirection: CONSULTING_FILTER_DEFAULTS.sortDirection,
    topN: CONSULTING_FILTER_DEFAULTS.topN,
  };
}
