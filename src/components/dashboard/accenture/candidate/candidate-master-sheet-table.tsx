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
import {
  DEFAULT_CANDIDATE_MASTER_PAGE_SIZE,
  CANDIDATE_MASTER_PAGE_SIZE_OPTIONS,
  isCandidateRoleNameColumn,
  type CandidateMasterDateFilter,
  type CandidateMasterFilterField,
  type CandidateMasterPageSize,
} from "@/services/excel/candidate-master-sheet";
import type { CandidateMasterSheetPgRow } from "@/services/persistence/candidate-master-sheet-postgres";
import { LateralMasterColumnFilter } from "@/components/dashboard/accenture/lateral/lateral-master-column-filter";
import {
  useMasterSheetScrollShell,
  MasterSheetTopScrollbar,
} from "@/components/dashboard/accenture/master-sheet-scroll-shell";
import { MasterSheetPaginationBar } from "@/components/dashboard/accenture/master-sheet-pagination-bar";
import { ExecutiveMasterContentModal } from "@/components/dashboard/accenture/executive/executive-master-content-modal";
import { cn } from "@/lib/utils";

interface CandidateMasterSheetTableProps {
  headers: string[];
  rows: CandidateMasterSheetPgRow[];
  total: number;
  page: number;
  pageSize: CandidateMasterPageSize;
  pageCount: number;
  isLoading?: boolean;
  isFetching?: boolean;
  errorMessage?: string | null;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: CandidateMasterPageSize) => void;
  /** Per-column header filters (Excel-style, reused from Lateral's Master Sheet). */
  filterFields?: CandidateMasterFilterField[];
  columnFilters?: Record<string, string[]>;
  textFilters?: Record<string, string>;
  dateFilters?: Record<string, CandidateMasterDateFilter>;
  onToggleColumnValue?: (column: string, value: string) => void;
  onClearColumn?: (column: string) => void;
  onTextChange?: (column: string, value: string) => void;
  onDateChange?: (column: string, range: CandidateMasterDateFilter) => void;
}

function RoleNameCell({
  preview,
  onOpen,
}: {
  preview: string;
  onOpen: () => void;
}) {
  const empty = !preview.trim() || preview === "-";
  if (empty) {
    return <span className="text-muted-foreground">-</span>;
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
      title="Click to view full Role Name/Primary Skill"
      aria-label="View full Role Name/Primary Skill"
    >
      {preview}
    </button>
  );
}

export function CandidateMasterSheetTable({
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
}: CandidateMasterSheetTableProps) {
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
    const map = new Map<string, CandidateMasterFilterField>();
    for (const field of filterFields ?? []) {
      map.set(field.column.trim(), field);
    }
    return map;
  }, [filterFields]);

  const filtersEnabled =
    Boolean(filterFields) &&
    Boolean(onToggleColumnValue && onClearColumn && onTextChange && onDateChange);

  const [roleNameOpen, setRoleNameOpen] = React.useState(false);
  const [roleNameContent, setRoleNameContent] = React.useState("");

  const roleNameHeader = React.useMemo(
    () => headers.find((header) => isCandidateRoleNameColumn(header)) ?? null,
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

  const openRoleNameForRow = React.useCallback(
    (row: CandidateMasterSheetPgRow) => {
      if (!roleNameHeader) return;
      captureScroll();
      const cell = row[roleNameHeader as keyof CandidateMasterSheetPgRow];
      setRoleNameContent(cell === null || cell === undefined ? "" : String(cell));
      setRoleNameOpen(true);
    },
    [captureScroll, roleNameHeader]
  );

  const handleModalOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setRoleNameOpen(nextOpen);
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
      <ExecutiveMasterContentModal
        open={roleNameOpen}
        title="Role Name/Primary Skill"
        content={roleNameContent}
        emptyMessage="No role name / primary skill provided."
        onOpenChange={handleModalOpenChange}
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
                    <TableHead className="h-11 w-16 whitespace-nowrap px-3 text-xs font-semibold tracking-wide text-primary uppercase">
                      Sr. No.
                    </TableHead>
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
                                onTextChange={(value) => onTextChange?.(header, value)}
                                onDateChange={(range) => onDateChange?.(header, range)}
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
                    rows.map((row, rowIndex) => {
                      const srNo = (page - 1) * pageSize + rowIndex + 1;
                      return (
                        <TableRow key={String(row.id)} className="hover:bg-accent/40">
                          <TableCell className="px-3 py-3 text-sm tabular-nums text-muted-foreground">
                            {srNo}
                          </TableCell>
                          {headers.map((header) => {
                            const value = row[header as keyof CandidateMasterSheetPgRow];
                            const display =
                              value === null || value === undefined || value === ""
                                ? "-"
                                : String(value);
                            const isRoleName = isCandidateRoleNameColumn(header);
                            return (
                              <TableCell
                                key={`${row.id}-${header}`}
                                className="max-w-[280px] px-3 py-3"
                              >
                                {isRoleName ? (
                                  <RoleNameCell
                                    preview={display}
                                    onOpen={() => openRoleNameForRow(row)}
                                  />
                                ) : (
                                  <span
                                    className="line-clamp-3 break-words"
                                    title={display}
                                  >
                                    {display}
                                  </span>
                                )}
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableRow>
                      <TableCell
                        colSpan={Math.max(headers.length + 1, 1)}
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
            pageSizeOptions={CANDIDATE_MASTER_PAGE_SIZE_OPTIONS}
            defaultPageSize={DEFAULT_CANDIDATE_MASTER_PAGE_SIZE}
            onPageChange={onPageChange}
            onPageSizeChange={(size) =>
              onPageSizeChange(size as CandidateMasterPageSize)
            }
          />
        </>
      )}
    </div>
  );
}
