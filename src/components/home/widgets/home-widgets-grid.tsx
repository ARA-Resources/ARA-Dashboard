"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, FileClock, RefreshCw } from "lucide-react";
import { HomeSection } from "@/components/home/home-section";
import { ActivityFeedWidget } from "@/components/home/widgets/activity-feed-widget";
import { ExcelSyncStatusWidget } from "@/components/home/widgets/excel-sync-status-widget";
import { MetricWidget } from "@/components/home/widgets/metric-widget";
import { MetricBreakdownPanel } from "@/components/home/widgets/metric-breakdown-panel";
import { RecentlyUpdatedOpeningsWidget } from "@/components/home/widgets/recently-updated-openings-widget";
import { useHomeWidgets } from "@/hooks/use-home-widgets";
import { staggerContainer } from "@/components/home/home-motion";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

type DetailWidgetId = "recentlyUpdated" | "syncStatus" | "activityFeed";
type MetricId =
  | "totalOpenPositions"
  | "activeOpenings"
  | "postedOpenings"
  | "newOpenings";

/**
 * Home live-ready widget grid.
 * All widgets read from `useHomeWidgets` — swap the service data source only.
 */
export function HomeWidgetsGrid() {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useHomeWidgets();
  const [activeMetric, setActiveMetric] = useState<MetricId | null>(null);
  const [activeDetailWidget, setActiveDetailWidget] =
    useState<DetailWidgetId | null>(null);
  const detailSectionRef = useRef<HTMLDivElement>(null);
  const metricsSectionRef = useRef<HTMLDivElement>(null);
  const metricPanelRef = useRef<HTMLElement>(null);

  const loading = isLoading || (isFetching && !data);
  const errorMessage =
    error instanceof Error ? error.message : "Failed to load dashboard widgets.";
  const breakdownTitle = useMemo(() => {
    if (!activeMetric) return "";
    const labels = {
      totalOpenPositions: "Total Open Positions",
      activeOpenings: "Active Openings",
      postedOpenings: "Posted Openings",
      newOpenings: "New Openings",
    } as const;
    return labels[activeMetric];
  }, [activeMetric]);
  const breakdownItems = activeMetric
    ? (data?.metricBreakdown?.[activeMetric] ?? [])
    : [];

  const retry = () => {
    void refetch();
  };

  function toggleDetailWidget(id: DetailWidgetId) {
    setActiveDetailWidget((current) => (current === id ? null : id));
  }

  function toggleMetric(id: MetricId) {
    setActiveMetric((current) => (current === id ? null : id));
  }

  useEffect(() => {
    if (!activeDetailWidget) return;

    function handlePointerDown(event: MouseEvent | TouchEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (detailSectionRef.current?.contains(target)) return;
      setActiveDetailWidget(null);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [activeDetailWidget]);

  useEffect(() => {
    if (!activeMetric) return;

    function handlePointerDown(event: MouseEvent | TouchEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      // Metric cards handle their own toggle — don't close here
      if (metricsSectionRef.current?.contains(target)) return;
      // Keep panel open when interacting with it
      if (metricPanelRef.current?.contains(target)) return;
      setActiveMetric(null);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [activeMetric]);

  return (
    <HomeSection
      id="home-dashboard-widgets"
      title="Dashboard Overview"
    >
      <motion.div
        className="space-y-4"
        variants={staggerContainer}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-40px" }}
      >
        <div
          ref={metricsSectionRef}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          <MetricWidget
            title="Total Open Positions"
            data={data?.metrics.totalOpenPositions}
            isLoading={loading}
            isError={isError}
            errorMessage={errorMessage}
            onRetry={retry}
            onOpenBreakdown={() => toggleMetric("totalOpenPositions")}
          />
          <MetricWidget
            title="Active Openings"
            data={data?.metrics.activeOpenings}
            isLoading={loading}
            isError={isError}
            errorMessage={errorMessage}
            onRetry={retry}
            onOpenBreakdown={() => toggleMetric("activeOpenings")}
          />
          <MetricWidget
            title="Posted Openings"
            data={data?.metrics.postedOpenings}
            isLoading={loading}
            isError={isError}
            errorMessage={errorMessage}
            onRetry={retry}
            onOpenBreakdown={() => toggleMetric("postedOpenings")}
          />
          <MetricWidget
            title="New Openings"
            data={data?.metrics.newOpenings}
            isLoading={loading}
            isError={isError}
            errorMessage={errorMessage}
            onRetry={retry}
            onOpenBreakdown={() => toggleMetric("newOpenings")}
          />
        </div>

        <div ref={detailSectionRef} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <button
              type="button"
              aria-expanded={activeDetailWidget === "recentlyUpdated"}
              onClick={() => toggleDetailWidget("recentlyUpdated")}
              className={cn(
                "group flex w-full items-center gap-3 rounded-2xl border bg-card p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[0_12px_30px_-14px_rgba(142,36,170,0.4)]",
                activeDetailWidget === "recentlyUpdated"
                  ? "border-primary/50 ring-2 ring-primary/20"
                  : "border-border/60"
              )}
            >
              <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <FileClock className="size-6" />
              </span>
              <div>
                <p className="text-sm font-semibold text-primary">
                  Recently Updated Openings
                </p>
              </div>
            </button>

            <button
              type="button"
              aria-expanded={activeDetailWidget === "syncStatus"}
              onClick={() => toggleDetailWidget("syncStatus")}
              className={cn(
                "group flex w-full items-center gap-3 rounded-2xl border bg-card p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[0_12px_30px_-14px_rgba(142,36,170,0.4)]",
                activeDetailWidget === "syncStatus"
                  ? "border-primary/50 ring-2 ring-primary/20"
                  : "border-border/60"
              )}
            >
              <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <RefreshCw className="size-6" />
              </span>
              <div>
                <p className="text-sm font-semibold text-primary">
                  Recent Excel Sync Status
                </p>
              </div>
            </button>

            <button
              type="button"
              aria-expanded={activeDetailWidget === "activityFeed"}
              onClick={() => toggleDetailWidget("activityFeed")}
              className={cn(
                "group flex w-full items-center gap-3 rounded-2xl border bg-card p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[0_12px_30px_-14px_rgba(142,36,170,0.4)]",
                activeDetailWidget === "activityFeed"
                  ? "border-primary/50 ring-2 ring-primary/20"
                  : "border-border/60"
              )}
            >
              <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Activity className="size-6" />
              </span>
              <div>
                <p className="text-sm font-semibold text-primary">
                  Latest Activity Feed
                </p>
              </div>
            </button>
          </div>

          {activeDetailWidget === "recentlyUpdated" ? (
            <RecentlyUpdatedOpeningsWidget
              data={data?.recentlyUpdatedOpenings}
              isLoading={loading}
              isError={isError}
              errorMessage={errorMessage}
              onRetry={retry}
            />
          ) : null}

          {activeDetailWidget === "syncStatus" ? (
            <ExcelSyncStatusWidget
              data={data?.excelSyncStatus}
              isLoading={loading}
              isError={isError}
              errorMessage={errorMessage}
              onRetry={retry}
            />
          ) : null}

          {activeDetailWidget === "activityFeed" ? (
            <ActivityFeedWidget
              data={data?.activityFeed}
              isLoading={loading}
              isError={isError}
              errorMessage={errorMessage}
              onRetry={retry}
            />
          ) : null}
        </div>
      </motion.div>
      <MetricBreakdownPanel
        ref={metricPanelRef}
        open={activeMetric !== null}
        title={breakdownTitle}
        items={breakdownItems}
        onClose={() => setActiveMetric(null)}
      />
    </HomeSection>
  );
}
