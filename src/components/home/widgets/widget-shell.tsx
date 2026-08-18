"use client";

import { AlertCircle, Inbox, RefreshCw } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fadeUp } from "@/components/home/home-motion";
import { cn } from "@/lib/utils";

interface WidgetShellProps {
  title: string;
  description?: string;
  className?: string;
  bodyClassName?: string;
  isLoading?: boolean;
  isError?: boolean;
  isEmpty?: boolean;
  errorMessage?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  onRetry?: () => void;
  skeleton?: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}

export function WidgetSkeletonBlock({
  rows = 3,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-3", className)}>
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-10 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function MetricWidgetSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="size-10 rounded-xl" />
      <Skeleton className="h-3 w-24 rounded-md" />
      <Skeleton className="h-8 w-20 rounded-md" />
      <Skeleton className="h-3 w-36 rounded-md" />
    </div>
  );
}

function WidgetEmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Inbox className="size-5" />
      </span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-xs text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function WidgetErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertCircle className="size-5" />
      </span>
      <div>
        <p className="text-sm font-medium text-foreground">Unable to load</p>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">{message}</p>
      </div>
      {onRetry ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="rounded-lg"
          onClick={onRetry}
        >
          <RefreshCw data-icon="inline-start" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function WidgetShell({
  title,
  description,
  className,
  bodyClassName,
  isLoading,
  isError,
  isEmpty,
  errorMessage = "Something went wrong while loading this widget.",
  emptyTitle = "No data yet",
  emptyDescription = "Data will appear here once Excel sources are available.",
  onRetry,
  skeleton,
  children,
  action,
}: WidgetShellProps) {
  return (
    <motion.section
      variants={fadeUp}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: "-40px" }}
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm",
        className
      )}
    >
      <header className="flex items-start justify-between gap-3 border-b border-border/60 px-5 py-3.5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight text-primary">
            {title}
          </h3>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </header>

      <div className={cn("flex flex-1 flex-col p-5", bodyClassName)}>
        {isLoading ? (
          skeleton ?? <WidgetSkeletonBlock />
        ) : isError ? (
          <WidgetErrorState message={errorMessage} onRetry={onRetry} />
        ) : isEmpty ? (
          <WidgetEmptyState title={emptyTitle} description={emptyDescription} />
        ) : (
          children
        )}
      </div>
    </motion.section>
  );
}
