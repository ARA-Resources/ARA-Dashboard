"use client";

import { WidgetShell, WidgetSkeletonBlock } from "@/components/home/widgets/widget-shell";
import type { BusinessUnitDistributionItem } from "@/types/home-widgets";
import { cn } from "@/lib/utils";

interface BusinessUnitDistributionWidgetProps {
  data?: BusinessUnitDistributionItem[];
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  className?: string;
}

const BAR_TONES = [
  "bg-primary",
  "bg-secondary",
  "bg-ara-highlight",
] as const;

export function BusinessUnitDistributionWidget({
  data = [],
  isLoading,
  isError,
  errorMessage,
  onRetry,
  className,
}: BusinessUnitDistributionWidgetProps) {
  return (
    <WidgetShell
      title="Business Unit Distribution"
      description="Share of open positions by business unit"
      className={className}
      isLoading={isLoading}
      isError={isError}
      isEmpty={!isLoading && !isError && data.length === 0}
      emptyTitle="No distribution data"
      emptyDescription="Business unit shares will appear once Excel openings are aggregated."
      errorMessage={errorMessage}
      onRetry={onRetry}
      skeleton={<WidgetSkeletonBlock rows={3} />}
    >
      <ul className="space-y-4">
        {data.map((item, index) => (
          <li key={item.businessUnitId}>
            <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
              <span className="font-medium text-foreground">{item.name}</span>
              <span className="tabular-nums text-muted-foreground">
                {item.openings.toLocaleString()} · {item.percent.toFixed(1)}%
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-700",
                  BAR_TONES[index % BAR_TONES.length]
                )}
                style={{ width: `${Math.min(100, Math.max(0, item.percent))}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </WidgetShell>
  );
}
