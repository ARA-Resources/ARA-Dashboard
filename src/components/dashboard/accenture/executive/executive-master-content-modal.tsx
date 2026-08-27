"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ExecutiveMasterContentModalProps {
  open: boolean;
  title: string;
  content: string;
  emptyMessage?: string;
  onOpenChange: (open: boolean) => void;
}

/**
 * Executive-only content modal for long Master Sheet cells (Must Have skills).
 * Does not alter Lateral Job Description modal behavior.
 */
export function ExecutiveMasterContentModal({
  open,
  title,
  content,
  emptyMessage = "No content provided.",
  onOpenChange,
}: ExecutiveMasterContentModalProps) {
  const trimmed = content.replace(/\u00a0/g, " ").trim();
  const isEmpty = !trimmed;

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
              {title}
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
            {isEmpty ? (
              <p className="text-sm text-muted-foreground">{emptyMessage}</p>
            ) : (
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground">
                {content}
              </pre>
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
