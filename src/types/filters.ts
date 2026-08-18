export type SortDirection = "asc" | "desc";

/**
 * User-editable openings filters.
 * Column keys and values always come from Excel (never hardcoded names).
 */
export interface OpeningsFilters {
  /**
   * Selected values per Excel column name.
   * Empty object / empty arrays = no column constraints.
   */
  columnFilters: Record<string, string[]>;
  /** Column to sort by on the result table; null = no explicit sort */
  sortBy: string | null;
  sortDirection: SortDirection;
  /** null = show all filtered rows */
  topN: number | null;
}

export const TOP_N_OPTIONS = [10, 25, 50, 100] as const;
