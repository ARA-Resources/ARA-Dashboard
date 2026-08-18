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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ExcelDataRow } from "@/types/excel";
import { OPENINGS_TABLE } from "@/constants/accenture-dashboard";
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
  );
}
