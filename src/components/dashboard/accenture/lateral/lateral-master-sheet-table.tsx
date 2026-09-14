"use client";

import * as React from "react";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
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
  useMasterSheetScrollShell,
  MasterSheetTopScrollbar,
} from "@/components/dashboard/accenture/master-sheet-scroll-shell";
import { MasterSheetPaginationBar } from "@/components/dashboard/accenture/master-sheet-pagination-bar";
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
  const {
    bodyScrollRef,
    tableRef,
    topScrollRef,
    mirrorWidth,
    onBodyScroll,
    onTopScroll,
  } = useMasterSheetScrollShell();
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
    const node = bodyScrollRef.current;
    if (!node) return;
    node.scrollLeft = savedTableScrollRef.current.left;
    node.scrollTop = savedTableScrollRef.current.top;
  }, [bodyScrollRef]);

  const openJobDescriptionForRow = React.useCallback(
    (row: ExcelDataRow) => {
      if (!jobDescriptionHeader) return;

      const scrollNode = bodyScrollRef.current;
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
    [bodyScrollRef, headers, jobDescriptionHeader]
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
          <div className="overflow-hidden rounded-xl border border-border">
            <MasterSheetTopScrollbar
              scrollRef={topScrollRef}
              onScroll={onTopScroll}
              width={mirrorWidth}
            />
            <div
              ref={bodyScrollRef}
              onScroll={onBodyScroll}
              data-slot="table-container"
              className="max-h-[70vh] overflow-auto"
            >
              <table ref={tableRef} className="w-full caption-bottom text-sm">
                <TableHeader className="sticky top-0 z-10">
                  <TableRow className="bg-muted hover:bg-muted">
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
                    isFetching &&
                      !isLoading &&
                      "pointer-events-none opacity-50"
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
              </table>
            </div>
          </div>

          <MasterSheetPaginationBar
            variant="full"
            total={total}
            page={page}
            pageSize={pageSize}
            pageCount={pageCount}
            pageSizeOptions={LATERAL_MASTER_PAGE_SIZE_OPTIONS}
            defaultPageSize={DEFAULT_LATERAL_MASTER_PAGE_SIZE}
            onPageChange={onPageChange}
            onPageSizeChange={(size) =>
              onPageSizeChange(size as LateralMasterPageSize)
            }
            extraStatus={
              isFetching && !isLoading ? (
                <span className="ml-2 text-xs text-primary">Updating…</span>
              ) : null
            }
          />
        </>
      )}
    </div>
  );
}
