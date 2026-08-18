import type { ExcelDataRow, ExcelCellValue } from "@/types/excel";
import type { OpeningsFilters } from "@/types/filters";

function asText(value: ExcelCellValue): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/**
 * Apply dynamic column filters from Excel headers.
 * Within a column: OR. Across columns: AND.
 */
export function applyColumnFilters(
  rows: ExcelDataRow[],
  columnFilters: Record<string, string[]>
): ExcelDataRow[] {
  const active = Object.entries(columnFilters).filter(
    ([, values]) => values.length > 0
  );
  if (active.length === 0) return rows;

  return rows.filter((row) =>
    active.every(([column, selected]) => {
      const cell = asText(row[column]);
      if (!cell) return false;
      return selected.some(
        (value) => value.toLowerCase() === cell.toLowerCase()
      );
    })
  );
}

export function applySortAndTopN(
  headers: string[],
  rows: ExcelDataRow[],
  filters: Pick<OpeningsFilters, "sortBy" | "sortDirection" | "topN">
) {
  const sorted = [...rows];
  const sortBy =
    filters.sortBy && headers.includes(filters.sortBy)
      ? filters.sortBy
      : null;

  if (sortBy) {
    sorted.sort((a, b) => {
      const left = a[sortBy];
      const right = b[sortBy];
      const leftNum = typeof left === "number" ? left : Number(left);
      const rightNum = typeof right === "number" ? right : Number(right);
      const leftValid = Number.isFinite(leftNum);
      const rightValid = Number.isFinite(rightNum);

      let comparison = 0;
      if (leftValid && rightValid) comparison = leftNum - rightNum;
      else comparison = asText(left).localeCompare(asText(right));

      return filters.sortDirection === "asc" ? comparison : -comparison;
    });
  }

  if (filters.topN === null || filters.topN === undefined) {
    return sorted;
  }

  return sorted.slice(0, Math.max(0, filters.topN));
}

export function countActiveColumnFilters(
  columnFilters: Record<string, string[]>
) {
  return Object.values(columnFilters).reduce(
    (count, values) => count + (values.length > 0 ? 1 : 0),
    0
  );
}
