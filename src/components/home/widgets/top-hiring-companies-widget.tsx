"use client";

import { Building2 } from "lucide-react";
import { WidgetShell, WidgetSkeletonBlock } from "@/components/home/widgets/widget-shell";
import type { HiringCompanyItem } from "@/types/home-widgets";

interface TopHiringCompaniesWidgetProps {
  data?: HiringCompanyItem[];
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  className?: string;
}

export function TopHiringCompaniesWidget({
  data = [],
  isLoading,
  isError,
  errorMessage,
  onRetry,
  className,
}: TopHiringCompaniesWidgetProps) {
  const ranked = data.filter((item) => item.openings > 0).slice(0, 10);

  return (
    <WidgetShell
      title="Top 10 Hiring Companies"
      description="Companies ranked by open positions"
      className={className}
      isLoading={isLoading}
      isError={isError}
      isEmpty={!isLoading && !isError && ranked.length === 0}
      emptyTitle="No hiring companies"
      emptyDescription="Company rankings will appear when openings data is available."
      errorMessage={errorMessage}
      onRetry={onRetry}
      skeleton={<WidgetSkeletonBlock rows={5} />}
    >
      <ol className="space-y-3">
        {ranked.map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/30 px-3 py-2.5 dark:bg-muted/10"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xs font-semibold text-primary">
              {item.rank}
            </span>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-card text-muted-foreground ring-1 ring-border/60">
              <Building2 className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {item.name}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {item.businessUnits.length > 0
                  ? item.businessUnits.join(" · ")
                  : "No units yet"}
              </p>
            </div>
            <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
              {item.openings.toLocaleString()}
            </p>
          </li>
        ))}
      </ol>
    </WidgetShell>
  );
}
