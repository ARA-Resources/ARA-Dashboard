"use client";

import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import { WidgetShell, WidgetSkeletonBlock } from "@/components/home/widgets/widget-shell";
import type { ExcelSyncStatusItem } from "@/types/home-widgets";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/utils/format-relative-time";

interface ExcelSyncStatusWidgetProps {
  data?: ExcelSyncStatusItem[];
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  className?: string;
}

const STATUS_META: Record<
  ExcelSyncStatusItem["status"],
  { icon: LucideIcon; label: string; className: string }
> = {
  success: {
    icon: CheckCircle2,
    label: "Synced",
    className: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
  },
  syncing: {
    icon: LoaderCircle,
    label: "Syncing",
    className: "text-primary bg-primary/10",
  },
  failed: {
    icon: AlertCircle,
    label: "Failed",
    className: "text-destructive bg-destructive/10",
  },
  stale: {
    icon: Clock3,
    label: "Stale",
    className: "text-amber-600 dark:text-amber-400 bg-amber-500/10",
  },
};

export function ExcelSyncStatusWidget({
  data = [],
  isLoading,
  isError,
  errorMessage,
  onRetry,
  className,
}: ExcelSyncStatusWidgetProps) {
  return (
    <WidgetShell
      title="Recent Excel Sync Status"
      description="Master sheet sync health by business unit"
      className={className}
      isLoading={isLoading}
      isError={isError}
      isEmpty={!isLoading && !isError && data.length === 0}
      emptyTitle="No sync history"
      emptyDescription="Excel sync status will appear after the first file load."
      errorMessage={errorMessage}
      onRetry={onRetry}
      skeleton={<WidgetSkeletonBlock rows={3} />}
    >
      <ul className="space-y-3">
        {data.map((item) => {
          const meta = STATUS_META[item.status];
          const Icon = meta.icon;
          return (
            <li
              key={item.id}
              className="rounded-xl border border-border/50 px-3 py-3"
            >
              <div className="flex items-start gap-3">
                <span
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-lg",
                    meta.className
                  )}
                >
                  <Icon
                    className={cn(
                      "size-4",
                      item.status === "syncing" && "animate-spin"
                    )}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-foreground">
                      {item.businessUnitName}
                    </p>
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {meta.label}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {item.fileName}
                  </p>
                  {item.message ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.message}
                    </p>
                  ) : null}
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {formatRelativeTime(item.lastSyncedAt)}
                  </p>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </WidgetShell>
  );
}
