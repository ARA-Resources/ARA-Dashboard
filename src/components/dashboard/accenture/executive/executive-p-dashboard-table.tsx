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
import { Skeleton } from "@/components/ui/skeleton";
import type { ExcelDataRow } from "@/types/excel";
import { cn } from "@/lib/utils";
import { polishExcelDisplayValue } from "@/utils/excel-display";

interface ExecutivePDashboardTableProps {
  headers: string[];
  data: ExcelDataRow[];
  globalFilter?: string;
  isLoading?: boolean;
  errorMessage?: string | null;
}

const LEVEL_HEADERS = new Set([
  "5-Associate Director",
  "6-Senior Manager",
  "7-Manager",
]);

function formatCellValue(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return String(value);
  const polished = polishExcelDisplayValue(value);
  return polished || "—";
}

function matchesSearch(row: ExcelDataRow, headers: string[], query: string) {
  if (!query.trim()) return true;
  if (/^grand\s*total$/i.test(String(row["Primary skills"] ?? ""))) return true;
  const q = query.toLowerCase();
  return headers.some((header) => {
    const value = row[header];
    if (value === null || value === undefined) return false;
    return String(value).toLowerCase().includes(q);
  });
}

export function ExecutivePDashboardTable({
  headers,
  data,
  globalFilter = "",
  isLoading = false,
  errorMessage = null,
}: ExecutivePDashboardTableProps) {
  const filtered = React.useMemo(() => {
    return data.filter((row) => matchesSearch(row, headers, globalFilter));
  }, [data, headers, globalFilter]);

  const bodyRows = filtered.filter(
    (row) => !/^grand\s*total$/i.test(String(row["Primary skills"] ?? ""))
  );
  const totalRow = filtered.find((row) =>
    /^grand\s*total$/i.test(String(row["Primary skills"] ?? ""))
  );

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full rounded-xl" />
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-full rounded-xl" />
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

  if (bodyRows.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-muted/20 p-8 text-center">
        <p className="text-sm font-medium text-foreground">
          No Executive roles match the selected filters.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Adjust Team Member 1, Priority, Job Status, or Posted and try again.
        </p>
        {totalRow ? (
          <p className="mt-4 text-xs tabular-nums text-muted-foreground">
            Grand Total · 5-AD {formatCellValue(totalRow["5-Associate Director"])}{" "}
            · 6-SM {formatCellValue(totalRow["6-Senior Manager"])} · 7-Mgr{" "}
            {formatCellValue(totalRow["7-Manager"])}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="overflow-auto rounded-xl border border-border">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-muted/95 backdrop-blur-sm">
          <TableRow className="hover:bg-muted/95">
            {headers.map((header) => (
              <TableHead
                key={header}
                className={cn(
                  "h-11 whitespace-nowrap px-3 text-xs font-semibold tracking-wide text-primary uppercase",
                  LEVEL_HEADERS.has(header) && "text-right"
                )}
              >
                {header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {bodyRows.map((row) => (
            <TableRow key={String(row.id)} className="hover:bg-accent/40">
              {headers.map((header) => {
                const value = row[header];
                const isLevel = LEVEL_HEADERS.has(header);
                return (
                  <TableCell
                    key={`${row.id}-${header}`}
                    className={cn(
                      "max-w-[220px] px-3 py-2.5",
                      isLevel && "text-right tabular-nums"
                    )}
                  >
                    <span
                      className={cn(
                        "line-clamp-2 break-words",
                        isLevel &&
                          typeof value === "number" &&
                          "font-semibold text-primary"
                      )}
                      title={formatCellValue(value)}
                    >
                      {formatCellValue(value)}
                    </span>
                  </TableCell>
                );
              })}
            </TableRow>
          ))}

          {totalRow ? (
            <TableRow className="border-t-2 border-primary/30 bg-muted/50 hover:bg-muted/50">
              {headers.map((header) => {
                const value = totalRow[header];
                const isLevel = LEVEL_HEADERS.has(header);
                const isLabel = header === "Primary skills";
                return (
                  <TableCell
                    key={`grand-${header}`}
                    className={cn(
                      "px-3 py-3",
                      isLevel && "text-right tabular-nums",
                      isLabel && "font-semibold text-foreground"
                    )}
                  >
                    {isLabel
                      ? "Grand Total"
                      : isLevel
                        ? formatCellValue(value === null || value === undefined ? 0 : value)
                        : null}
                  </TableCell>
                );
              })}
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}
