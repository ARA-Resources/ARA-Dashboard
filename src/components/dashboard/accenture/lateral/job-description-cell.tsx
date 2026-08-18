"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export function isJobDescriptionColumn(header: string): boolean {
  return /job\s*description/i.test(header.trim());
}

interface JobDescriptionCellProps {
  /** Truncated preview text shown in the table cell */
  preview: string;
  className?: string;
  /** Opens the single shared table-level modal for this row. */
  onOpen: () => void;
}

/**
 * Truncated, clickable Job Description cell.
 * Does not render a modal — only notifies the parent table.
 */
export function JobDescriptionCell({
  preview,
  className,
  onOpen,
}: JobDescriptionCellProps) {
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
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      title="Click to view full Job Description"
      aria-label="View full Job Description"
    >
      {preview}
    </button>
  );
}
