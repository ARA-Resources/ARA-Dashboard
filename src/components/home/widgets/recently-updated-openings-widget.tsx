"use client";

import { WidgetShell, WidgetSkeletonBlock } from "@/components/home/widgets/widget-shell";
import type { RecentlyUpdatedOpening } from "@/types/home-widgets";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/utils/format-relative-time";

interface RecentlyUpdatedOpeningsWidgetProps {
  data?: RecentlyUpdatedOpening[];
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  className?: string;
}

const STATUS_STYLES: Record<
  RecentlyUpdatedOpening["status"],
  string
> = {
  active: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  posted: "bg-primary/10 text-primary",
  new: "bg-secondary/10 text-secondary",
  closed: "bg-muted text-muted-foreground",
};

export function RecentlyUpdatedOpeningsWidget({
  data = [],
  isLoading,
  isError,
  errorMessage,
  onRetry,
  className,
}: RecentlyUpdatedOpeningsWidgetProps) {
  return (
    <WidgetShell
      title="Recently Updated Openings"
      description="Latest role changes across business units"
      className={className}
      isLoading={isLoading}
      isError={isError}
      isEmpty={!isLoading && !isError && data.length === 0}
      emptyTitle="No recent updates"
      emptyDescription="Updated openings will show here after the next Excel sync."
      errorMessage={errorMessage}
      onRetry={onRetry}
      skeleton={<WidgetSkeletonBlock rows={5} />}
      bodyClassName="p-0"
    >
      <ul className="divide-y divide-border/60">
        {data.map((item) => (
          <li
            key={item.id}
            className="flex flex-col gap-2 px-5 py-3.5 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {item.title}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {item.company} · {item.businessUnit}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span
                className={cn(
                  "rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                  STATUS_STYLES[item.status]
                )}
              >
                {item.status}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatRelativeTime(item.updatedAt)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </WidgetShell>
  );
}
