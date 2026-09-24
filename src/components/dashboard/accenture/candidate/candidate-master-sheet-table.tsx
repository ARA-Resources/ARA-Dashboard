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
  isCandidateIdColumn,
  isCandidateRoleNameColumn,
  type CandidateMasterDateFilter,
  type CandidateMasterFilterField,
  type CandidateMasterPageSize,
} from "@/services/excel/candidate-master-sheet";
import type { CandidateHistoryEntry } from "@/services/persistence/read-candidate-highlights";
import type {
  CandidateFieldFlag,
  CandidateMasterSheetHighlights,
  CandidateMasterSheetPgRow,
} from "@/services/persistence/candidate-master-sheet-postgres";
import { LateralMasterColumnFilter } from "@/components/dashboard/accenture/lateral/lateral-master-column-filter";
import {
  useMasterSheetScrollShell,
  MasterSheetTopScrollbar,
} from "@/components/dashboard/accenture/master-sheet-scroll-shell";
import { MasterSheetPaginationBar } from "@/components/dashboard/accenture/master-sheet-pagination-bar";
import { ExecutiveMasterContentModal } from "@/components/dashboard/accenture/executive/executive-master-content-modal";
import { CandidateFlagDetailModal } from "@/components/dashboard/accenture/candidate/candidate-flag-detail-modal";
import { CandidateHistoryModal } from "@/components/dashboard/accenture/candidate/candidate-history-modal";
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
  /** C9 highlighting: changed-cell / duplicate-row / conflict-flag state for the current page's rows. */
  highlights?: CandidateMasterSheetHighlights;
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
      title="Click to view full Primary Skills"
      aria-label="View full Primary Skills"
    >
      {preview}
    </button>
  );
}

function CandidateIdCell({ cid, onOpen }: { cid: string; onOpen: () => void }) {
  const empty = !cid.trim() || cid === "-";
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
      title="Click to view change history"
      aria-label={`View change history for ${cid}`}
    >
      {cid}
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
  highlights,
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

  const [flagModalOpen, setFlagModalOpen] = React.useState(false);
  const [flagModalFlag, setFlagModalFlag] = React.useState<CandidateFieldFlag | null>(null);

  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [historyCid, setHistoryCid] = React.useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = React.useState<CandidateHistoryEntry[]>([]);

  const roleNameHeader = React.useMemo(
    () => headers.find((header) => isCandidateRoleNameColumn(header)) ?? null,
    [headers]
  );

  const duplicateFlagCidSet = React.useMemo(
    () => new Set(highlights?.duplicateFlagCids ?? []),
    [highlights]
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

  const openFlagModal = React.useCallback(
    (flag: CandidateFieldFlag) => {
      captureScroll();
      setFlagModalFlag(flag);
      setFlagModalOpen(true);
    },
    [captureScroll]
  );

  const handleFlagModalOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setFlagModalOpen(nextOpen);
      if (!nextOpen) {
        requestAnimationFrame(() => {
          restoreTableScroll();
          window.setTimeout(restoreTableScroll, 0);
        });
      }
    },
    [restoreTableScroll]
  );

  const openHistoryForCid = React.useCallback(
    (cid: string) => {
      captureScroll();
      setHistoryCid(cid);
      setHistoryOpen(true);
      setHistoryLoading(true);
      setHistoryError(null);
      setHistoryEntries([]);
      fetch(`/api/excel/candidate-master-sheet/${encodeURIComponent(cid)}/history`, {
        cache: "no-store",
      })
        .then(async (res) => {
          const payload = (await res.json().catch(() => null)) as
            | { ok?: boolean; error?: string; entries?: CandidateHistoryEntry[] }
            | null;
          if (!res.ok || !payload?.ok) {
            throw new Error(payload?.error ?? "Failed to load change history.");
          }
          setHistoryEntries(payload.entries ?? []);
        })
        .catch((err: unknown) => {
          setHistoryError(err instanceof Error ? err.message : "Failed to load change history.");
        })
        .finally(() => {
          setHistoryLoading(false);
        });
    },
    [captureScroll]
  );

  const handleHistoryModalOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setHistoryOpen(nextOpen);
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
        title="Primary Skills"
        content={roleNameContent}
        emptyMessage="No primary skills provided."
        onOpenChange={handleModalOpenChange}
      />

      <CandidateFlagDetailModal
        open={flagModalOpen}
        flag={flagModalFlag}
        onOpenChange={handleFlagModalOpenChange}
      />

      <CandidateHistoryModal
        open={historyOpen}
        cid={historyCid}
        loading={historyLoading}
        error={historyError}
        entries={historyEntries}
        onOpenChange={handleHistoryModalOpenChange}
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
                      const cid = row["Candidate ID"];
                      const isDuplicateFlagged = Boolean(cid && duplicateFlagCidSet.has(cid));
                      const changedHeaders = cid ? highlights?.changedCellsByCid[cid] : undefined;
                      const fieldFlags = cid ? highlights?.fieldFlagsByCid[cid] : undefined;
                      return (
                        <TableRow
                          key={String(row.id)}
                          className={cn(
                            "hover:bg-accent/40",
                            isDuplicateFlagged && "bg-rose-500/5 hover:bg-rose-500/10"
                          )}
                          title={
                            isDuplicateFlagged
                              ? "This Candidate ID appeared more than once in the most recent sync with mismatched names — needs manual review."
                              : undefined
                          }
                        >
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
                            const isCandidateId = isCandidateIdColumn(header);
                            const fieldFlag = fieldFlags?.find((f) => f.header === header);
                            const isChanged = changedHeaders?.some((h) => h === header) ?? false;
                            return (
                              <TableCell
                                key={`${row.id}-${header}`}
                                className={cn(
                                  "max-w-[280px] px-3 py-3",
                                  fieldFlag
                                    ? "bg-amber-500/10"
                                    : isChanged && "bg-emerald-500/10"
                                )}
                              >
                                {fieldFlag ? (
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      openFlagModal(fieldFlag);
                                    }}
                                    className={cn(
                                      "block w-full max-w-full truncate rounded-md px-1.5 py-1 text-left text-sm",
                                      "text-amber-700 underline-offset-2 dark:text-amber-400",
                                      "cursor-pointer transition-colors hover:bg-amber-500/15 hover:underline",
                                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    )}
                                    title="Click to view review flag details"
                                    aria-label={`View review flag for ${header}`}
                                  >
                                    {display}
                                  </button>
                                ) : isRoleName ? (
                                  <RoleNameCell
                                    preview={display}
                                    onOpen={() => openRoleNameForRow(row)}
                                  />
                                ) : isCandidateId ? (
                                  <CandidateIdCell
                                    cid={display}
                                    onOpen={() => openHistoryForCid(display)}
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
