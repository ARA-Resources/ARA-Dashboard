import type { BusinessUnitId } from "@/types/business-unit";

/** Shared async status for every home widget */
export type WidgetStatus = "idle" | "loading" | "success" | "empty" | "error";

export interface MetricWidgetData {
  id: string;
  label: string;
  value: number;
  /** Short helper text under the value */
  description: string;
  /** Optional delta vs previous period, e.g. +12 */
  changePercent?: number;
  trend?: "up" | "down" | "flat";
}

export interface BusinessUnitMetricBreakdownItem {
  businessUnitId: BusinessUnitId;
  name: string;
  value: number;
}

export interface BusinessUnitDistributionItem {
  businessUnitId: BusinessUnitId;
  name: string;
  openings: number;
  /** 0–100 share of total */
  percent: number;
}

export interface RecentlyUpdatedOpening {
  id: string;
  title: string;
  businessUnit: string;
  company: string;
  updatedAt: string;
  status: "active" | "posted" | "new" | "closed";
}

export interface HiringCompanyItem {
  id: string;
  rank: number;
  name: string;
  openings: number;
  businessUnits: string[];
}

export interface ExcelSyncStatusItem {
  id: string;
  businessUnitId: BusinessUnitId;
  businessUnitName: string;
  fileName: string;
  status: "success" | "syncing" | "failed" | "stale";
  lastSyncedAt: string;
  message?: string;
}

export interface ActivityFeedItem {
  id: string;
  title: string;
  detail?: string;
  timestamp: string;
  status: "success" | "info" | "warning" | "neutral" | "error";
}

/**
 * Full Home dashboard payload.
 * Live Excel/API responses should map into this shape —
 * widgets never read mock files or fetchers directly.
 */
export interface HomeDashboardWidgetsData {
  metrics: {
    totalOpenPositions: MetricWidgetData;
    activeOpenings: MetricWidgetData;
    postedOpenings: MetricWidgetData;
    newOpenings: MetricWidgetData;
  };
  metricBreakdown: {
    totalOpenPositions: BusinessUnitMetricBreakdownItem[];
    activeOpenings: BusinessUnitMetricBreakdownItem[];
    postedOpenings: BusinessUnitMetricBreakdownItem[];
    newOpenings: BusinessUnitMetricBreakdownItem[];
  };
  businessUnitDistribution: BusinessUnitDistributionItem[];
  recentlyUpdatedOpenings: RecentlyUpdatedOpening[];
  topHiringCompanies: HiringCompanyItem[];
  excelSyncStatus: ExcelSyncStatusItem[];
  activityFeed: ActivityFeedItem[];
  /** ISO timestamp of when this snapshot was produced */
  generatedAt: string;
}

export type HomeWidgetKey =
  | "totalOpenPositions"
  | "activeOpenings"
  | "postedOpenings"
  | "newOpenings"
  | "businessUnitDistribution"
  | "recentlyUpdatedOpenings"
  | "topHiringCompanies"
  | "excelSyncStatus"
  | "activityFeed";
