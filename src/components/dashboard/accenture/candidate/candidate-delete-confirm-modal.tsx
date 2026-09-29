"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CandidateMasterSheetPgRow } from "@/services/persistence/candidate-master-sheet-postgres";
import { useDeleteCandidateRow } from "@/hooks/use-candidate-master-row-mutations";

export interface CandidateDeleteConfirmModalProps {
  open: boolean;
  row: CandidateMasterSheetPgRow | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: (row: CandidateMasterSheetPgRow) => void;
}

/**
 * Candidate Master Sheet — Delete confirmation (migration 021). Soft
 * delete: the row is hidden immediately and recoverable for 30 days (see
 * candidate-purge-scheduler.ts), not gone the moment this is confirmed.
 */
export function CandidateDeleteConfirmModal({
  open,
  row,
  onOpenChange,
  onDeleted,
}: CandidateDeleteConfirmModalProps) {
  const deleteMutation = useDeleteCandidateRow();
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setError(null);
      deleteMutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleConfirm() {
    if (!row) return;
    setError(null);
    try {
      await deleteMutation.mutateAsync(Number(row.id));
      onDeleted(row);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete.");
    }
  }

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
            "fixed top-1/2 left-1/2 z-50 flex w-[min(28rem,calc(100vw-2rem))]",
            "-translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-2xl border border-border",
            "bg-popover p-5 text-sm text-popover-foreground shadow-lg outline-none",
            "transition duration-150",
            "data-ending-style:opacity-0 data-ending-style:scale-95",
            "data-starting-style:opacity-0 data-starting-style:scale-95"
          )}
        >
          <div className="flex items-start justify-between gap-3 pr-8">
            <DialogPrimitive.Title className="flex items-center gap-2 text-base font-semibold text-foreground">
              <AlertTriangle className="size-4 text-destructive" />
              Delete candidate?
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

          <p className="text-sm text-foreground">
            Delete{" "}
            <span className="font-semibold">
              {row?.["Candidate ID"] ?? ""} — {row?.Name ?? ""}
            </span>
            ? It will be hidden from the Master Sheet immediately and permanently removed after 30
            days. It can be manually restored by an admin within that window.
          </p>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <DialogPrimitive.Close render={<Button type="button" variant="ghost" size="sm" />}>
              No
            </DialogPrimitive.Close>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="gap-1.5"
              disabled={deleteMutation.isPending}
              onClick={() => void handleConfirm()}
            >
              {deleteMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Yes, delete
            </Button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
