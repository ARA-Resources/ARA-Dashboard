"use client";

import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Info,
  TriangleAlert,
} from "lucide-react";
import { WidgetShell, WidgetSkeletonBlock } from "@/components/home/widgets/widget-shell";
import type { ActivityFeedItem } from "@/types/home-widgets";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/utils/format-relative-time";

interface ActivityFeedWidgetProps {
  data?: ActivityFeedItem[];
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  className?: string;
}

const STATUS_STYLES: Record<
  ActivityFeedItem["status"],
  { icon: typeof CheckCircle2; className: string }
> = {
  success: {
    icon: CheckCircle2,
    className: "text-emerald-600 dark:text-emerald-400",
  },
  info: {
    icon: Info,
    className: "text-primary",
  },
  warning: {
    icon: TriangleAlert,
    className: "text-amber-600 dark:text-amber-400",
  },
  error: {
    icon: AlertCircle,
    className: "text-destructive",
  },
  neutral: {
    icon: Circle,
    className: "text-muted-foreground",
  },
};

export function ActivityFeedWidget({
  data = [],
  isLoading,
  isError,
  errorMessage,
  onRetry,
  className,
}: ActivityFeedWidgetProps) {
  return (
    <WidgetShell
      title="Latest Activity Feed"
      description="Recent workspace and Excel events"
      className={className}
      isLoading={isLoading}
      isError={isError}
      isEmpty={!isLoading && !isError && data.length === 0}
      emptyTitle="No recent activity"
      emptyDescription="Activity will show here as dashboards and Excel files update."
      errorMessage={errorMessage}
      onRetry={onRetry}
      skeleton={<WidgetSkeletonBlock rows={5} />}
      bodyClassName="pt-4"
    >
      <ol className="relative space-y-0">
        {data.map((item, index) => {
          const meta = STATUS_STYLES[item.status];
          const Icon = meta.icon;
          const isLast = index === data.length - 1;
          return (
            <li key={item.id} className="relative flex gap-3 pb-5 last:pb-0">
              {!isLast ? (
                <span
                  aria-hidden
                  className="absolute top-8 left-[15px] h-[calc(100%-1.25rem)] w-px bg-border"
                />
              ) : null}
              <span
                className={cn(
                  "relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted/80 ring-4 ring-card",
                  meta.className
                )}
              >
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 pt-0.5">
                <p className="text-sm font-medium text-foreground">{item.title}</p>
                {item.detail ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.detail}
                  </p>
                ) : null}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {formatRelativeTime(item.timestamp)}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </WidgetShell>
  );
}
