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
  DEFAULT_EXECUTIVE_MASTER_PAGE_SIZE,
  EXECUTIVE_MASTER_PAGE_SIZE_OPTIONS,
  isExecutiveJobDescriptionColumn,
  isExecutiveMustHaveSkillsColumn,
  type ExecutiveMasterDateFilter,
  type ExecutiveMasterFilterField,
  type ExecutiveMasterPageSize,
} from "@/services/excel/executive-master-sheet";
import type { ExecutiveMasterSheetPgRow } from "@/services/persistence/executive-master-sheet-postgres";
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
import { JobDescriptionCell } from "@/components/dashboard/accenture/lateral/job-description-cell";
import { JobDescriptionModal } from "@/components/dashboard/accenture/lateral/job-description-modal";
import { ExecutiveMasterContentModal } from "@/components/dashboard/accenture/executive/executive-master-content-modal";
import {
  extractJobDescriptionMeta,
  type JobDescriptionOpenPayload,
} from "@/utils/format-job-description";
import { buildJobDescriptionSelectionKey } from "@/utils/structured-job-description-view";
import { cn } from "@/lib/utils";

type ExecutiveMasterSheetRow = ExecutiveMasterSheetPgRow;

interface ExecutiveMasterSheetTableProps {
  headers: string[];
  rows: ExecutiveMasterSheetRow[];
  total: number;
  page: number;
  pageSize: ExecutiveMasterPageSize;
  pageCount: number;
  isLoading?: boolean;
  isFetching?: boolean;
  errorMessage?: string | null;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: ExecutiveMasterPageSize) => void;
  /** Per-column header filters (Excel-style, reused from Lateral's Master Sheet). */
  filterFields?: ExecutiveMasterFilterField[];
  columnFilters?: Record<string, string[]>;
  textFilters?: Record<string, string>;
  dateFilters?: Record<string, ExecutiveMasterDateFilter>;
  onToggleColumnValue?: (column: string, value: string) => void;
  onClearColumn?: (column: string) => void;
  onTextChange?: (column: string, value: string) => void;
  onDateChange?: (column: string, range: ExecutiveMasterDateFilter) => void;
}

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

function findHeader(
  headers: string[],
  predicate: (header: string) => boolean
): string | null {
  return headers.find((header) => predicate(header)) ?? null;
}

function buildJobDescriptionPayload(
  headers: string[],
  row: ExcelDataRow,
  jobDescriptionHeader: string
): JobDescriptionOpenPayload {
  const cell = row[jobDescriptionHeader];
  const description =
    cell === null || cell === undefined ? "" : String(cell);
  const meta = extractJobDescriptionMeta(
    headers,
    row as Record<string, unknown>
  );

  return {
    description,
    meta,
    selectionKey: buildJobDescriptionSelectionKey(description, meta),
  };
}

function TruncatedActionCell({
  preview,
  ariaLabel,
  title,
  onOpen,
}: {
  preview: string;
  ariaLabel: string;
  title: string;
  onOpen: () => void;
}) {
  const empty = !preview.trim() || preview === "—";
  if (empty) {
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
      className={cn(
        "block w-full max-w-full truncate rounded-md px-1.5 py-1 text-left text-sm text-primary underline-offset-2",
        "cursor-pointer transition-colors",
        "hover:bg-primary/10 hover:underline",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
      title={title}
      aria-label={ariaLabel}
    >
      {preview}
    </button>
  );
}

export function ExecutiveMasterSheetTable({
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
  filterFields,
  columnFilters,
  textFilters,
  dateFilters,
  onToggleColumnValue,
  onClearColumn,
  onTextChange,
  onDateChange,
}: ExecutiveMasterSheetTableProps) {
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
    const map = new Map<string, ExecutiveMasterFilterField>();
    for (const field of filterFields ?? []) {
      map.set(field.column.trim(), field);
    }
    return map;
  }, [filterFields]);

  const filtersEnabled =
    Boolean(filterFields) &&
    Boolean(
      onToggleColumnValue && onClearColumn && onTextChange && onDateChange
    );

  const [jobDescriptionOpen, setJobDescriptionOpen] = React.useState(false);
  const [jobDescriptionPayload, setJobDescriptionPayload] =
    React.useState<JobDescriptionOpenPayload | null>(null);

  const [mustHaveOpen, setMustHaveOpen] = React.useState(false);
  const [mustHaveContent, setMustHaveContent] = React.useState("");

  const jobDescriptionHeader = React.useMemo(
    () => findHeader(headers, isExecutiveJobDescriptionColumn),
    [headers]
  );
  const mustHaveHeader = React.useMemo(
    () => findHeader(headers, isExecutiveMustHaveSkillsColumn),
    [headers]
  );

  const restoreTableScroll = React.useCallback(() => {
    const node = bodyScrollRef.current;
    if (!node) return;
    node.scrollLeft = savedTableScrollRef.current.left;
    node.scrollTop = savedTableScrollRef.current.top;
  }, [bodyScrollRef]);

  const captureScroll = React.useCallback(() => {
    const scrollNode = bodyScrollRef.current;
    if (!scrollNode) return;
    savedTableScrollRef.current = {
      left: scrollNode.scrollLeft,
      top: scrollNode.scrollTop,
    };
  }, [bodyScrollRef]);

  const openJobDescriptionForRow = React.useCallback(
    (row: ExecutiveMasterSheetRow) => {
      if (!jobDescriptionHeader) return;
      captureScroll();
      setJobDescriptionPayload(
        buildJobDescriptionPayload(headers, row, jobDescriptionHeader)
      );
      setJobDescriptionOpen(true);
    },
    [captureScroll, headers, jobDescriptionHeader]
  );

  const openMustHaveForRow = React.useCallback(
    (row: ExecutiveMasterSheetRow) => {
      if (!mustHaveHeader) return;
      captureScroll();
      const cell = row[mustHaveHeader as keyof ExecutiveMasterSheetRow];
      setMustHaveContent(
        cell === null || cell === undefined ? "" : String(cell)
      );
      setMustHaveOpen(true);
    },
    [captureScroll, mustHaveHeader]
  );

  const handleModalOpenChange = React.useCallback(
    (setter: (open: boolean) => void) => (nextOpen: boolean) => {
      setter(nextOpen);
      if (!nextOpen) {
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
      <JobDescriptionModal
        open={jobDescriptionOpen}
        description={jobDescriptionPayload?.description ?? ""}
        meta={jobDescriptionPayload?.meta ?? []}
        selectionKey={jobDescriptionPayload?.selectionKey ?? ""}
        onOpenChange={handleModalOpenChange(setJobDescriptionOpen)}
        downloadFormat="pdf"
      />

      <ExecutiveMasterContentModal
        open={mustHaveOpen}
        title="Must Have skills"
        content={mustHaveContent}
        emptyMessage="No must-have skills provided."
        onOpenChange={handleModalOpenChange(setMustHaveOpen)}
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
                          className="h-11 whitespace-nowrap px-3 text-xs font-semibold tracking-wide text-primary uppercase"
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
                          const value =
                            row[header as keyof ExecutiveMasterSheetRow];
                          const display = formatCellValue(
                            header,
                            value as string | number | null | undefined
                          );
                          const isDateCol = isExcelDateColumnHeader(header);
                          const isJobDesc =
                            isExecutiveJobDescriptionColumn(header);
                          const isMustHave =
                            isExecutiveMustHaveSkillsColumn(header);
                          const isNumeric =
                            typeof value === "number" &&
                            !isDateCol &&
                            !isJobDesc &&
                            !isMustHave &&
                            !formatExcelDateDdMmYyyy(value);
                          return (
                            <TableCell
                              key={`${row.id}-${header}`}
                              className="max-w-[280px] px-3 py-3"
                            >
                              {isJobDesc ? (
                                <JobDescriptionCell
                                  preview={display}
                                  onOpen={() => openJobDescriptionForRow(row)}
                                />
                              ) : isMustHave ? (
                                <TruncatedActionCell
                                  preview={display}
                                  title="Click to view full Must Have skills"
                                  ariaLabel="View full Must Have skills"
                                  onOpen={() => openMustHaveForRow(row)}
                                />
                              ) : (
                                <span
                                  className={cn(
                                    "line-clamp-3 break-words",
                                    isNumeric &&
                                      "font-semibold tabular-nums text-primary",
                                    isDateCol && "tabular-nums"
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
            pageSizeOptions={EXECUTIVE_MASTER_PAGE_SIZE_OPTIONS}
            defaultPageSize={DEFAULT_EXECUTIVE_MASTER_PAGE_SIZE}
            onPageChange={onPageChange}
            onPageSizeChange={(size) =>
              onPageSizeChange(size as ExecutiveMasterPageSize)
            }
          />
        </>
      )}
    </div>
  );
}
