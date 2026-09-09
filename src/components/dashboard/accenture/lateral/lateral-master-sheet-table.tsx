"use client";

import * as React from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ExcelDataRow } from "@/types/excel";
import {
  DEFAULT_LATERAL_MASTER_PAGE_SIZE,
  LATERAL_MASTER_PAGE_SIZE_OPTIONS,
  type LateralMasterDateFilter,
  type LateralMasterFilterSchema,
  type LateralMasterPageSize,
} from "@/services/excel/lateral-master-sheet";
import { LateralMasterColumnFilter } from "@/components/dashboard/accenture/lateral/lateral-master-column-filter";
import {
  polishExcelDisplayValue,
  formatExcelDateDdMmYyyy,
  isExcelDateColumnHeader,
} from "@/utils/excel-display";
import {
  JobDescriptionCell,
  isJobDescriptionColumn,
} from "@/components/dashboard/accenture/lateral/job-description-cell";
import { JobDescriptionModal } from "@/components/dashboard/accenture/lateral/job-description-modal";
import {
  extractJobDescriptionMeta,
  type JobDescriptionOpenPayload,
} from "@/utils/format-job-description";
import { buildJobDescriptionSelectionKey } from "@/utils/structured-job-description-view";
import { cn } from "@/lib/utils";

interface LateralMasterSheetTableProps {
  headers: string[];
  rows: ExcelDataRow[];
  total: number;
  page: number;
  pageSize: LateralMasterPageSize;
  pageCount: number;
  isLoading?: boolean;
  /** A filter/page refetch is in flight — dim the body, keep the header crisp. */
  isFetching?: boolean;
  errorMessage?: string | null;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: LateralMasterPageSize) => void;
  /** Per-column header filters (Excel-style). Omit to render plain headers. */
  filterSchema?: LateralMasterFilterSchema;
  columnFilters?: Record<string, string[]>;
  textFilters?: Record<string, string>;
  dateFilters?: Record<string, LateralMasterDateFilter>;
  onToggleColumnValue?: (column: string, value: string) => void;
  onClearColumn?: (column: string) => void;
  onTextChange?: (column: string, value: string) => void;
  onDateChange?: (column: string, range: LateralMasterDateFilter) => void;
}

/**
 * Per-column layout overrides, keyed by Excel header. Columns not listed keep
 * the default sizing (auto width, capped at max-w-[280px]). `table-layout` is
 * `auto`, so narrowing one column just frees space for the others.
 */
const COLUMN_LAYOUT: Partial<
  Record<string, { head: string; cell: string; span: string }>
> = {
  // POC holds short person names (~25 distinct); keep it tight.
  POC: {
    head: "max-w-[7rem]",
    cell: "max-w-[7rem]",
    span: "whitespace-normal",
  },
};

function formatCellValue(
  header: string,
  value: string | number | null | undefined
) {
  if (value === null || value === undefined || value === "") return "—";

  if (isExcelDateColumnHeader(header)) {
    const asDate = formatExcelDateDdMmYyyy(value);
    if (asDate) return asDate;
  } else {
    const asDate = formatExcelDateDdMmYyyy(value);
    if (asDate && typeof value !== "number") return asDate;
  }

  if (typeof value === "number") return String(value);
  const polished = polishExcelDisplayValue(value);
  return polished || "—";
}

function findJobDescriptionHeader(headers: string[]): string | null {
  return headers.find((header) => isJobDescriptionColumn(header)) ?? null;
}

function buildJobDescriptionPayload(
  headers: string[],
  row: ExcelDataRow,
  jobDescriptionHeader: string
): JobDescriptionOpenPayload {
  // Exact Master Sheet cell — do not trim, parse, or rewrite (source of truth).
  const cell = row[jobDescriptionHeader];
  const description =
    cell === null || cell === undefined ? "" : String(cell);
  const meta = extractJobDescriptionMeta(headers, row as Record<string, unknown>);

  return {
    description,
    meta,
    selectionKey: buildJobDescriptionSelectionKey(description, meta),
  };
}

/**
 * Master Sheet table with exactly ONE shared JobDescriptionModal.
 * Opening/closing the modal must not alter page, filters, sort, or scroll state.
 */
export function LateralMasterSheetTable({
  headers,
  rows,
  total,
  page,
  pageSize,
  pageCount,
  isLoading = false,
  isFetching = false,
  errorMessage = null,
  onPageChange,
  onPageSizeChange,
  filterSchema,
  columnFilters,
  textFilters,
  dateFilters,
  onToggleColumnValue,
  onClearColumn,
  onTextChange,
  onDateChange,
}: LateralMasterSheetTableProps) {
  const tableScrollRef = React.useRef<HTMLDivElement>(null);
  const savedTableScrollRef = React.useRef({ left: 0, top: 0 });

  const filterFieldByHeader = React.useMemo(() => {
    const map = new Map<
      string,
      NonNullable<typeof filterSchema>["fields"][number]
    >();
    for (const field of filterSchema?.fields ?? []) {
      map.set(field.column.trim(), field);
    }
    return map;
  }, [filterSchema]);

  const filtersEnabled =
    Boolean(filterSchema) &&
    Boolean(
      onToggleColumnValue && onClearColumn && onTextChange && onDateChange
    );

  const [jobDescriptionOpen, setJobDescriptionOpen] = React.useState(false);
  const [jobDescriptionPayload, setJobDescriptionPayload] =
    React.useState<JobDescriptionOpenPayload | null>(null);

  const jobDescriptionHeader = React.useMemo(
    () => findJobDescriptionHeader(headers),
    [headers]
  );

  const restoreTableScroll = React.useCallback(() => {
    const node = tableScrollRef.current;
    if (!node) return;
    node.scrollLeft = savedTableScrollRef.current.left;
    node.scrollTop = savedTableScrollRef.current.top;
  }, []);

  const openJobDescriptionForRow = React.useCallback(
    (row: ExcelDataRow) => {
      if (!jobDescriptionHeader) return;

      const scrollNode = tableScrollRef.current;
      if (scrollNode) {
        savedTableScrollRef.current = {
          left: scrollNode.scrollLeft,
          top: scrollNode.scrollTop,
        };
      }

      // Replace payload in the single shared modal (no per-row modal instances)
      setJobDescriptionPayload(
        buildJobDescriptionPayload(headers, row, jobDescriptionHeader)
      );
      setJobDescriptionOpen(true);
    },
    [headers, jobDescriptionHeader]
  );

  const handleJobDescriptionOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setJobDescriptionOpen(nextOpen);
      if (!nextOpen) {
        // Keep table page / filters / sort untouched; restore scroll after unlock.
        // Payload is fully replaced on the next open (selectionKey changes).
        requestAnimationFrame(() => {
          restoreTableScroll();
          window.setTimeout(restoreTableScroll, 0);
        });
      }
    },
    [restoreTableScroll]
  );

  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  return (
    <div className="space-y-4">
      {/* Single reusable modal — payload replaced atomically per selected row */}
      <JobDescriptionModal
        open={jobDescriptionOpen}
        description={jobDescriptionPayload?.description ?? ""}
        meta={jobDescriptionPayload?.meta ?? []}
        selectionKey={jobDescriptionPayload?.selectionKey ?? ""}
        onOpenChange={handleJobDescriptionOpenChange}
        downloadFormat="docx"
      />

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full rounded-xl" />
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full rounded-xl" />
          ))}
        </div>
      ) : errorMessage ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          {errorMessage}
        </div>
      ) : (
        <>
          <div
            ref={tableScrollRef}
            className="overflow-auto rounded-xl border border-border"
          >
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  {headers.map((header) => {
                    const field = filtersEnabled
                      ? filterFieldByHeader.get(header.trim())
                      : undefined;
                    return (
                      <TableHead
                        key={header}
                        className={cn(
                          "h-11 whitespace-nowrap px-3 text-xs font-semibold tracking-wide text-primary uppercase",
                          COLUMN_LAYOUT[header]?.head
                        )}
                      >
                        <span className="inline-flex items-center gap-1">
                          {header}
                          {field ? (
                            <LateralMasterColumnFilter
                              field={field}
                              selectedValues={columnFilters?.[header] ?? []}
                              textValue={textFilters?.[header] ?? ""}
                              dateValue={dateFilters?.[header] ?? {}}
                              onToggleValue={(value) =>
                                onToggleColumnValue?.(header, value)
                              }
                              onClearColumn={() => onClearColumn?.(header)}
                              onTextChange={(value) =>
                                onTextChange?.(header, value)
                              }
                              onDateChange={(range) =>
                                onDateChange?.(header, range)
                              }
                            />
                          ) : null}
                        </span>
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody
                className={cn(
                  "transition-opacity",
                  isFetching && !isLoading && "pointer-events-none opacity-50"
                )}
              >
                {rows.length > 0 ? (
                  rows.map((row) => (
                    <TableRow
                      key={String(row.id)}
                      className="hover:bg-accent/40"
                    >
                      {headers.map((header) => {
                        const value = row[header];
                        const display = formatCellValue(
                          header,
                          value as string | number | null | undefined
                        );
                        const isDateCol = isExcelDateColumnHeader(header);
                        const isJobDesc = isJobDescriptionColumn(header);
                        const isNumeric =
                          typeof value === "number" &&
                          !isDateCol &&
                          !isJobDesc &&
                          !formatExcelDateDdMmYyyy(value);
                        return (
                          <TableCell
                            key={`${row.id}-${header}`}
                            className={cn(
                              "px-3 py-3",
                              COLUMN_LAYOUT[header]?.cell ?? "max-w-[280px]"
                            )}
                          >
                            {isJobDesc ? (
                              <JobDescriptionCell
                                preview={display}
                                onOpen={() => openJobDescriptionForRow(row)}
                              />
                            ) : (
                              <span
                                className={cn(
                                  "line-clamp-3 break-words",
                                  isNumeric &&
                                    "font-semibold tabular-nums text-primary",
                                  isDateCol && "tabular-nums",
                                  COLUMN_LAYOUT[header]?.span
                                )}
                                title={display}
                              >
                                {display}
                              </span>
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={Math.max(headers.length, 1)}
                      className="h-28 text-center text-muted-foreground"
                    >
                      No Master Sheet rows match the current filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <p className="text-sm text-muted-foreground">
              Showing{" "}
              <span className="font-medium text-foreground">{start}</span>–
              <span className="font-medium text-foreground">{end}</span> of{" "}
              <span className="font-medium text-foreground">{total}</span>
              {isFetching && !isLoading ? (
                <span className="ml-2 text-xs text-primary">Updating…</span>
              ) : null}
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  Rows per page
                </span>
                <Select
                  value={String(pageSize)}
                  onValueChange={(value) => {
                    const next = Number(value) as LateralMasterPageSize;
                    onPageSizeChange(
                      LATERAL_MASTER_PAGE_SIZE_OPTIONS.includes(next)
                        ? next
                        : DEFAULT_LATERAL_MASTER_PAGE_SIZE
                    );
                  }}
                >
                  <SelectTrigger className="h-9 w-[100px] rounded-lg">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LATERAL_MASTER_PAGE_SIZE_OPTIONS.map((size) => (
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
                  onClick={() => onPageChange(Math.max(1, page - 1))}
                  disabled={page <= 1 || total === 0}
                >
                  Previous
                </Button>
                <span className="min-w-16 text-center text-sm text-muted-foreground">
                  {total === 0 ? 0 : page} / {Math.max(pageCount, 1)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-lg"
                  onClick={() => onPageChange(page + 1)}
                  disabled={page >= pageCount || total === 0}
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
