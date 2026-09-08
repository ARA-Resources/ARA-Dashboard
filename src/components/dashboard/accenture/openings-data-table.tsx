"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createColumnHelper,
  createPaginatedRowModel,
  rowPaginationFeature,
  tableFeatures,
  useTable,
  type PaginationState,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ExcelDataRow } from "@/types/excel";
import {
  OPENINGS_TABLE,
  OPENINGS_TABLE_PAGE_SIZE_OPTIONS,
} from "@/constants/accenture-dashboard";
import { cn } from "@/lib/utils";
import { polishExcelDisplayValue } from "@/utils/excel-display";

const features = tableFeatures({
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

const helper = createColumnHelper<typeof features, ExcelDataRow>();

interface OpeningsDataTableProps {
  headers: string[];
  data: ExcelDataRow[];
  globalFilter: string;
  isLoading?: boolean;
  errorMessage?: string | null;
  /**
   * Render a pinned "Grand Total" footer row with column-wise sums across every
   * filtered row (not just the current page). Used by the Lateral P-Roles pivot.
   */
  showGrandTotalRow?: boolean;
}

const GRAND_TOTAL_LABEL_COLUMNS = new Set([
  "Primary Skills",
  "Skill Categorization",
]);

/** Column-wise sums over the filtered rows, for the Grand Total footer. */
function computeColumnTotals(
  rows: ExcelDataRow[],
  headers: string[]
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const header of headers) {
    if (GRAND_TOTAL_LABEL_COLUMNS.has(header)) continue;
    let sum = 0;
    let sawNumber = false;
    for (const row of rows) {
      const value = row[header];
      if (typeof value === "number" && Number.isFinite(value)) {
        sum += value;
        sawNumber = true;
      }
    }
    if (sawNumber) totals[header] = sum;
  }
  return totals;
}

function matchesSearch(row: ExcelDataRow, headers: string[], query: string) {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  return headers.some((header) => {
    const value = row[header];
    if (value === null || value === undefined) return false;
    return String(value).toLowerCase().includes(q);
  });
}

function formatCellValue(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return String(value);
  const polished = polishExcelDisplayValue(value);
  return polished || "—";
}

export function OpeningsDataTable({
  headers,
  data,
  globalFilter,
  isLoading = false,
  errorMessage = null,
  showGrandTotalRow = false,
}: OpeningsDataTableProps) {
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: OPENINGS_TABLE.pageSize,
  });

  const columns = useMemo(() => {
    if (headers.length === 0) return helper.columns([]);

    return helper.columns(
      headers.map((header) =>
        helper.accessor((row) => row[header] ?? null, {
          id: header,
          header,
          cell: (info) => {
            const value = info.getValue();
            const isNumeric = typeof value === "number";
            return (
              <span
                className={cn(
                  isNumeric && "font-semibold tabular-nums text-primary"
                )}
              >
                {formatCellValue(value)}
              </span>
            );
          },
        })
      )
    );
  }, [headers]);

  const filteredData = useMemo(() => {
    return data.filter((row) => matchesSearch(row, headers, globalFilter));
  }, [data, headers, globalFilter]);

  const columnTotals = useMemo(
    () =>
      showGrandTotalRow ? computeColumnTotals(filteredData, headers) : null,
    [showGrandTotalRow, filteredData, headers]
  );

  useEffect(() => {
    setPagination((current) =>
      current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }
    );
  }, [globalFilter, data, headers]);

  const table = useTable(
    {
      features,
      columns,
      data: filteredData,
      state: { pagination },
      onPaginationChange: setPagination,
      getRowId: (row) => String(row.id),
    },
    (state) => ({
      pagination: state.pagination,
    })
  );

  const rows = table.getRowModel().rows;
  const pageCount = table.getPageCount();
  const pageIndex = table.state.pagination.pageIndex;
  const pageSize = table.state.pagination.pageSize;
  const rowCount = table.getRowCount();
  const columnCount = Math.max(headers.length, 1);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full rounded-xl" />
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
        {errorMessage}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow
                key={headerGroup.id}
                className="bg-muted/40 hover:bg-muted/40"
              >
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="h-11 px-3 text-xs font-semibold tracking-wide text-primary uppercase"
                  >
                    {header.isPlaceholder ? null : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.length > 0 ? (
              rows.map((row) => (
                <TableRow key={row.id} className="hover:bg-accent/40">
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id} className="px-3 py-3">
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columnCount}
                  className="h-28 text-center text-muted-foreground"
                >
                  No openings found for this business unit.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
          {columnTotals && rows.length > 0 ? (
            <TableFooter className="sticky bottom-0 bg-muted/60">
              <TableRow className="hover:bg-muted/60">
                {headers.map((header, index) => {
                  if (index === 0) {
                    return (
                      <TableCell
                        key={header}
                        className="px-3 py-3 font-semibold text-primary"
                      >
                        Grand Total
                      </TableCell>
                    );
                  }
                  const total = columnTotals[header];
                  return (
                    <TableCell key={header} className="px-3 py-3">
                      {typeof total === "number" ? (
                        <span className="font-semibold tabular-nums text-primary">
                          {total}
                        </span>
                      ) : null}
                    </TableCell>
                  );
                })}
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Showing{" "}
          <span className="font-medium text-foreground">
            {rowCount === 0 ? 0 : pageIndex * pageSize + 1}
          </span>
          –
          <span className="font-medium text-foreground">
            {Math.min((pageIndex + 1) * pageSize, rowCount)}
          </span>{" "}
          of <span className="font-medium text-foreground">{rowCount}</span>
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Rows per page</span>
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                setPagination({ pageIndex: 0, pageSize: Number(value) });
              }}
            >
              <SelectTrigger className="h-9 w-[100px] rounded-lg">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPENINGS_TABLE_PAGE_SIZE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              Previous
            </Button>
            <span className="min-w-16 text-center text-sm text-muted-foreground">
              {pageCount === 0 ? 0 : pageIndex + 1} / {Math.max(pageCount, 1)}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              Next
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
