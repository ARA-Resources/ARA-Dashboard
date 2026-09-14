"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface MasterSheetPaginationBarProps {
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  pageSizeOptions: readonly number[];
  defaultPageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  /**
   * "full" — the original bottom-of-table bar ("Showing X–Y of Z" + labeled
   * rows-per-page select + Previous/Next).
   * "compact" — a smaller version meant to sit inline in a page/card header
   * row (no "Showing" text, unlabeled select, icon-tight buttons).
   */
  variant?: "full" | "compact";
  className?: string;
  /** Extra inline status shown after the "Showing X–Y of Z" text (full variant only). */
  extraStatus?: React.ReactNode;
}

export function MasterSheetPaginationBar({
  total,
  page,
  pageSize,
  pageCount,
  pageSizeOptions,
  defaultPageSize,
  onPageChange,
  onPageSizeChange,
  variant = "full",
  className,
  extraStatus,
}: MasterSheetPaginationBarProps) {
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  const pageSizeSelect = (
    <Select
      value={String(pageSize)}
      onValueChange={(value) => {
        const next = Number(value);
        onPageSizeChange(
          pageSizeOptions.includes(next) ? next : defaultPageSize
        );
      }}
    >
      <SelectTrigger
        className={cn(
          "rounded-lg",
          variant === "compact" ? "h-7 w-[76px] text-xs" : "h-9 w-[100px]"
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {pageSizeOptions.map((size) => (
          <SelectItem key={size} value={String(size)}>
            {size}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const prevNext = (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size={variant === "compact" ? "icon" : "sm"}
        className={cn("rounded-lg", variant === "compact" && "size-7")}
        onClick={() => onPageChange(Math.max(1, page - 1))}
        disabled={page <= 1 || total === 0}
        aria-label="Previous page"
      >
        {variant === "compact" ? "‹" : "Previous"}
      </Button>
      <span
        className={cn(
          "text-center text-muted-foreground",
          variant === "compact" ? "min-w-12 text-xs" : "min-w-16 text-sm"
        )}
      >
        {total === 0 ? 0 : page} / {Math.max(pageCount, 1)}
      </span>
      <Button
        variant="outline"
        size={variant === "compact" ? "icon" : "sm"}
        className={cn("rounded-lg", variant === "compact" && "size-7")}
        onClick={() => onPageChange(page + 1)}
        disabled={page >= pageCount || total === 0}
        aria-label="Next page"
      >
        {variant === "compact" ? "›" : "Next"}
      </Button>
    </div>
  );

  if (variant === "compact") {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        {pageSizeSelect}
        {prevNext}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between",
        className
      )}
    >
      <p className="text-sm text-muted-foreground">
        Showing <span className="font-medium text-foreground">{start}</span>–
        <span className="font-medium text-foreground">{end}</span> of{" "}
        <span className="font-medium text-foreground">{total}</span>
        {extraStatus}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Rows per page</span>
          {pageSizeSelect}
        </div>
        {prevNext}
      </div>
    </div>
  );
}
