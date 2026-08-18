"use client";

import { motion } from "framer-motion";
import {
  BriefcaseBusiness,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { AnimatedCounter } from "@/components/home/animated-counter";
import {
  MetricWidgetSkeleton,
  WidgetShell,
} from "@/components/home/widgets/widget-shell";
import { cardHover } from "@/components/home/home-motion";
import type { MetricWidgetData } from "@/types/home-widgets";

const METRIC_ICONS: Record<string, LucideIcon> = {
  "total-open-positions": BriefcaseBusiness,
  "active-openings": BriefcaseBusiness,
  "posted-openings": BriefcaseBusiness,
  "new-openings": Sparkles,
};

interface MetricWidgetProps {
  title: string;
  data?: MetricWidgetData;
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  onOpenBreakdown?: () => void;
  className?: string;
}

export function MetricWidget({
  title,
  data,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  onOpenBreakdown,
  className,
}: MetricWidgetProps) {
  const Icon = data ? METRIC_ICONS[data.id] ?? BriefcaseBusiness : BriefcaseBusiness;

  return (
    <WidgetShell
      title={title}
      className={className}
      isLoading={isLoading}
      isError={isError}
      isEmpty={!isLoading && !isError && !data}
      emptyTitle="No metric data"
      emptyDescription="Openings metrics will appear when Excel data is connected."
      errorMessage={errorMessage}
      onRetry={onRetry}
      skeleton={<MetricWidgetSkeleton />}
      bodyClassName="pt-4"
    >
      {data ? (
        <motion.button
          type="button"
          onClick={onOpenBreakdown}
          disabled={!onOpenBreakdown}
          initial="rest"
          whileHover="hover"
          animate="rest"
          variants={cardHover}
          className="flex h-full w-full flex-col text-left disabled:cursor-default"
        >
          <motion.div
            className="mb-4 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"
            whileHover={{ rotate: 6 }}
          >
            <Icon className="size-5" />
          </motion.div>

          <p className="text-3xl font-semibold tracking-tight text-foreground">
            <AnimatedCounter value={data.value} />
          </p>

          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {data.description}
          </p>
        </motion.button>
      ) : null}
    </WidgetShell>
  );
}
