"use client";

import * as React from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function ManagerSection({
  id,
  title,
  description,
  icon: Icon,
  open,
  onToggle,
  badge,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  icon: LucideIcon;
  open: boolean;
  onToggle: () => void;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        "overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm transition-colors",
        open && "border-primary/25"
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/40 sm:items-center sm:px-5"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{title}</span>
            {badge}
          </span>
          {description ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {description}
            </span>
          ) : null}
        </span>
        <ChevronDown
          className={cn(
            "mt-1 size-4 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-180"
          )}
        />
      </button>
      {open ? (
        <div
          id={`${id}-panel`}
          className="border-t border-border/70 bg-background/40 px-4 py-4 sm:px-5"
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}
