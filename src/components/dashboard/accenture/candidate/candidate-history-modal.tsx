"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ArrowLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CandidateHistoryEntry } from "@/services/persistence/read-candidate-highlights";
import { kindLabelClassName } from "@/services/candidate-processing/candidate-history-label-style";
import {
  CANDIDATE_MASTER_EXCEL_HEADERS,
  type CandidateMasterExcelHeader,
} from "@/services/persistence/candidate-master-sheet-columns";

export interface CandidateHistoryModalProps {
  open: boolean;
  cid: string | null;
  loading: boolean;
  error: string | null;
  entries: CandidateHistoryEntry[];
  onOpenChange: (open: boolean) => void;
}

/** "YYYY-MM-DD" -> "DD/MM/YYYY" by splitting the string — never built into a JS Date, so no timezone shift is possible. */
function formatReportDateOnly(dateKey: string): string {
  const parts = dateKey.split("-");
  if (parts.length !== 3) return dateKey;
  const [yyyy, mm, dd] = parts;
  return `${dd}/${mm}/${yyyy}`;
}

/** Any TIMESTAMPTZ instant (changed_at or started_at) -> "DD/MM/YYYY, hh:mm AM/PM" in Asia/Kolkata. */
function formatIstDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")}, ${get("hour")}:${get("minute")} ${get("dayPeriod")}`;
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
 * newest first (Stage 3) — the opposite of C9's "latest sync only"
 * highlight rule.
 *
 * Opens to a grid of per-field summary tiles (count of changes per field,
 * in Candidate Master Sheet column order via CANDIDATE_MASTER_EXCEL_HEADERS
 * — the same source of truth the table itself uses); clicking a tile drills
 * into that field's card list with a Back button. No entry reaching this
 * modal is ever header-less (read-candidate-highlights.ts already skips any
 * field_name that doesn't map to a column), so grouping never has a
 * leftover bucket — the `grouped.length === 0` check below is defensive
 * only.
 */
export function CandidateHistoryModal({
  open,
  cid,
  loading,
  error,
  entries,
  onOpenChange,
}: CandidateHistoryModalProps) {
  const [selectedHeader, setSelectedHeader] = React.useState<CandidateMasterExcelHeader | null>(null);

  React.useEffect(() => {
    setSelectedHeader(null);
  }, [cid]);

  const grouped = React.useMemo(() => {
    const byHeader = new Map<CandidateMasterExcelHeader, CandidateHistoryEntry[]>();
    for (const entry of entries) {
      const list = byHeader.get(entry.header);
      if (list) list.push(entry);
      else byHeader.set(entry.header, [entry]);
    }
    return CANDIDATE_MASTER_EXCEL_HEADERS.filter((header) => byHeader.has(header)).map((header) => ({
      header,
      items: byHeader.get(header)!,
    }));
  }, [entries]);

  const selectedGroup = selectedHeader ? grouped.find((g) => g.header === selectedHeader) ?? null : null;

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
            ) : entries.length === 0 || grouped.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No recorded changes for this candidate yet.
              </p>
            ) : selectedGroup ? (
              <div>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground">{selectedGroup.header}</h3>
                  <Button variant="ghost" size="sm" onClick={() => setSelectedHeader(null)}>
                    <ArrowLeft className="size-4" />
                    Back
                  </Button>
                </div>
                <ol className="space-y-3">
                  {selectedGroup.items.map((entry, index) => (
                    <li
                      key={index}
                      className="rounded-lg border border-border/60 bg-background p-3"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                        <span className="font-medium text-foreground">{entry.header}</span>
                        <span className="text-xs text-muted-foreground">
                          {entry.reportDate ? formatReportDateOnly(entry.reportDate) : formatIstDateTime(entry.changedAt)}
                        </span>
                      </div>
                      {entry.reportDate && entry.startedAt ? (
                        <p className="text-[10px] text-muted-foreground/70">
                          Uploaded {formatIstDateTime(entry.startedAt)}
                        </p>
                      ) : null}
                      <p className={cn("mt-0.5 text-xs font-medium", kindLabelClassName(entry.kindLabel))}>
                        {entry.kindLabel}
                      </p>
                      {entry.isAccentureNameMismatch ? (
                        <p className="mt-1 break-words text-foreground">
                          Name mismatch noted (Accenture): {entry.newValue}, not applied
                        </p>
                      ) : (
                        <p className="mt-1 break-words text-foreground">
                          <span className="text-muted-foreground line-through">{entry.oldValue}</span>
                          <span className="mx-1.5 text-muted-foreground">&rarr;</span>
                          <span>{entry.newValue}</span>
                        </p>
                      )}
                      {entry.sourceFilename || entry.triggeredBy ? (
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {entry.sourceFilename ?? "-"}
                          {entry.triggeredBy ? ` · ${entry.triggeredBy}` : ""}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {grouped.map((group) => (
                  <button
                    key={group.header}
                    type="button"
                    onClick={() => setSelectedHeader(group.header)}
                    className="rounded-lg border border-border/60 bg-background p-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="block text-xs font-medium text-primary">{group.header}</span>
                    <span className="mt-1 block text-2xl font-bold text-foreground">{group.items.length}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
