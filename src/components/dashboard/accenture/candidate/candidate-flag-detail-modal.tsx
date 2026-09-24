"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CandidateFieldFlag } from "@/services/persistence/candidate-master-sheet-postgres";

export interface CandidateFlagDetailModalProps {
  open: boolean;
  flag: CandidateFieldFlag | null;
  onOpenChange: (open: boolean) => void;
}

const REASON_LABELS: Record<string, string> = {
  jr_id_conflict: "Job Requisition Conflict",
  unclean_contact_number: "Unclean Contact Number",
  legacy_contact_number_unclean: "Unclean Contact Number (legacy)",
  missing_job_requisition_id: "Missing Job Requisition ID",
};

function FlagBody({ flag }: { flag: CandidateFieldFlag }) {
  if (flag.reason === "missing_job_requisition_id") {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          This candidate has no Job Requisition ID on the most recent live
          sync — every real Oorwin row is expected to carry one going
          forward. The row was still saved as-is; nothing was guessed at.
        </p>
      </div>
    );
  }

  if (flag.reason === "jr_id_conflict") {
    const lateralValue = String(flag.detail.lateralValue ?? "-");
    const executiveValue = String(flag.detail.executiveValue ?? "-");
    return (
      <dl className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Lateral Master and Executive Master disagree on this candidate&apos;s{" "}
          {flag.header} for this Job Requisition ID — neither was auto-applied.
        </p>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Lateral Master says
          </dt>
          <dd className="text-foreground">{lateralValue}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Executive Master says
          </dt>
          <dd className="text-foreground">{executiveValue}</dd>
        </div>
      </dl>
    );
  }

  // unclean_contact_number / legacy_contact_number_unclean
  const raw = String(flag.detail.raw ?? "-");
  return (
    <div className="space-y-2 text-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Raw value from the source sheet
      </p>
      <p className="text-foreground">{raw}</p>
      <p className="text-muted-foreground">
        Didn&apos;t cleanly reduce to a 10-digit number — left unchanged rather
        than guessed at.
      </p>
    </div>
  );
}

/**
 * Candidate Master Sheet — per-field review flag detail (C9 highlighting).
 * Same interaction shell as ExecutiveMasterContentModal (click-to-expand
 * cell -> shared modal instance), but renders structured per-reason content
 * instead of a plain string, since a flag's `detail` JSONB has real shape
 * worth showing directly (see candidate-sync-engine.ts for the exact
 * payload per reason).
 */
export function CandidateFlagDetailModal({
  open,
  flag,
  onOpenChange,
}: CandidateFlagDetailModalProps) {
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
            "fixed top-1/2 left-1/2 z-50 flex w-[min(36rem,calc(100vw-2rem))] max-h-[min(70vh,36rem)]",
            "-translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-2xl border border-border",
            "bg-popover p-5 text-sm text-popover-foreground shadow-lg outline-none",
            "transition duration-150",
            "data-ending-style:opacity-0 data-ending-style:scale-95",
            "data-starting-style:opacity-0 data-starting-style:scale-95"
          )}
        >
          <div className="flex items-start justify-between gap-3 pr-8">
            <DialogPrimitive.Title className="text-base font-semibold text-foreground">
              {flag ? (REASON_LABELS[flag.reason] ?? flag.reason) : "Review flag"}
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
            {flag ? (
              <FlagBody flag={flag} />
            ) : (
              <p className="text-sm text-muted-foreground">No flag selected.</p>
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
