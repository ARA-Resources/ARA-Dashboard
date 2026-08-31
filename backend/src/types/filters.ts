export type SortDirection = "asc" | "desc";

export interface OpeningsFilters {
  columnFilters: Record<string, string[]>;
  sortBy: string | null;
  sortDirection: SortDirection;
  topN: number | null;
}
