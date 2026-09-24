"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CandidateHistoryEntry } from "@/services/persistence/read-candidate-highlights";

export interface CandidateHistoryModalProps {
  open: boolean;
  cid: string | null;
  loading: boolean;
  error: string | null;
  entries: CandidateHistoryEntry[];
  onOpenChange: (open: boolean) => void;
}

function formatChangedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Candidate Master Sheet — C10 full change history popup. Opens from
 * clicking a Candidate ID cell; same modal shell as
 * ExecutiveMasterContentModal / CandidateFlagDetailModal (click-to-expand
 * cell -> shared modal instance), but fetched on demand rather than
 * preloaded, since (unlike C9's page-scoped highlight state) fetching full
 * history for every visible row up front would be wasted work for rows
 * nobody clicks.
 *
 * Deliberately unfiltered: every field change ever recorded for this CID,
 * oldest first — the opposite of C9's "latest sync only" highlight rule.
 */
export function CandidateHistoryModal({
  open,
  cid,
  loading,
  error,
  entries,
  onOpenChange,
}: CandidateHistoryModalProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-black/40 transition-opacity duration-150",
            "data-ending-style:opacity-0 data-starting-style:opacity-0",
            "supports-backdrop-filter:backdrop-blur-xs"
          )}
        />
        <DialogPrimitive.Popup
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex w-[min(40rem,calc(100vw-2rem))] max-h-[min(75vh,42rem)]",
            "-translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-2xl border border-border",
            "bg-popover p-5 text-sm text-popover-foreground shadow-lg outline-none",
            "transition duration-150",
            "data-ending-style:opacity-0 data-ending-style:scale-95",
            "data-starting-style:opacity-0 data-starting-style:scale-95"
          )}
        >
          <div className="flex items-start justify-between gap-3 pr-8">
            <DialogPrimitive.Title className="text-base font-semibold text-foreground">
              Change History — {cid ?? ""}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-3 right-3 rounded-lg"
                  aria-label="Close"
                />
              }
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border/60 bg-muted/20 p-4">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading history…</p>
            ) : error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No recorded changes for this candidate yet.
              </p>
            ) : (
              <ol className="space-y-3">
                {entries.map((entry, index) => (
                  <li
                    key={index}
                    className="rounded-lg border border-border/60 bg-background p-3"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                      <span className="font-medium text-foreground">{entry.header}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatChangedAt(entry.changedAt)}
                      </span>
                    </div>
                    <p className="mt-1 break-words text-foreground">
                      <span className="text-muted-foreground line-through">{entry.oldValue}</span>
                      <span className="mx-1.5 text-muted-foreground">&rarr;</span>
                      <span>{entry.newValue}</span>
                    </p>
                    {entry.sourceFilename || entry.triggeredBy ? (
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {entry.sourceFilename ?? "-"}
                        {entry.triggeredBy ? ` · ${entry.triggeredBy}` : ""}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
