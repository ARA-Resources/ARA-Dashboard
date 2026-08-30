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
  DEFAULT_EXECUTIVE_MASTER_PAGE_SIZE,
  EXECUTIVE_MASTER_PAGE_SIZE_OPTIONS,
  isExecutiveJobDescriptionColumn,
  isExecutiveMustHaveSkillsColumn,
  type ExecutiveMasterPageSize,
  type ExecutiveMasterSheetRow,
} from "@/services/excel/executive-master-sheet";
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

interface ExecutiveMasterSheetTableProps {
  headers: string[];
  rows: ExecutiveMasterSheetRow[];
  total: number;
  page: number;
  pageSize: ExecutiveMasterPageSize;
  pageCount: number;
  isLoading?: boolean;
  errorMessage?: string | null;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: ExecutiveMasterPageSize) => void;
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
  errorMessage = null,
  onPageChange,
  onPageSizeChange,
}: ExecutiveMasterSheetTableProps) {
  const tableScrollRef = React.useRef<HTMLDivElement>(null);
  const savedTableScrollRef = React.useRef({ left: 0, top: 0 });

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
    const node = tableScrollRef.current;
    if (!node) return;
    node.scrollLeft = savedTableScrollRef.current.left;
    node.scrollTop = savedTableScrollRef.current.top;
  }, []);

  const captureScroll = React.useCallback(() => {
    const scrollNode = tableScrollRef.current;
    if (!scrollNode) return;
    savedTableScrollRef.current = {
      left: scrollNode.scrollLeft,
      top: scrollNode.scrollTop,
    };
  }, []);

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

  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  return (
    <div className="space-y-4">
      <JobDescriptionModal
        open={jobDescriptionOpen}
        description={jobDescriptionPayload?.description ?? ""}
        meta={jobDescriptionPayload?.meta ?? []}
        selectionKey={jobDescriptionPayload?.selectionKey ?? ""}
        onOpenChange={handleModalOpenChange(setJobDescriptionOpen)}
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
          <div
            ref={tableScrollRef}
            className="overflow-auto rounded-xl border border-border"
          >
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  {headers.map((header) => (
                    <TableHead
                      key={header}
                      className="h-11 whitespace-nowrap px-3 text-xs font-semibold tracking-wide text-primary uppercase"
                    >
                      {header}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
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
            </Table>
          </div>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <p className="text-sm text-muted-foreground">
              Showing{" "}
              <span className="font-medium text-foreground">{start}</span>–
              <span className="font-medium text-foreground">{end}</span> of{" "}
              <span className="font-medium text-foreground">{total}</span>
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  Rows per page
                </span>
                <Select
                  value={String(pageSize)}
                  onValueChange={(value) => {
                    const next = Number(value) as ExecutiveMasterPageSize;
                    onPageSizeChange(
                      EXECUTIVE_MASTER_PAGE_SIZE_OPTIONS.includes(next)
                        ? next
                        : DEFAULT_EXECUTIVE_MASTER_PAGE_SIZE
                    );
                  }}
                >
                  <SelectTrigger className="h-9 w-[100px] rounded-lg">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXECUTIVE_MASTER_PAGE_SIZE_OPTIONS.map((size) => (
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
