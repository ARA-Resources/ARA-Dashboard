export type BusinessUnitId = "lateral" | "executive" | "consulting";

export type MetricWidgetData = {
  id: string;
  label: string;
  value: number;
  description: string;
  changePercent?: number;
  trend?: "up" | "down" | "flat";
};

export type BusinessUnitMetricBreakdownItem = {
  businessUnitId: BusinessUnitId;
  name: string;
  value: number;
};

export type BusinessUnitDistributionItem = {
  businessUnitId: BusinessUnitId;
  name: string;
  openings: number;
  percent: number;
};

export type ExcelSyncStatusItem = {
  id: string;
  businessUnitId: BusinessUnitId;
  businessUnitName: string;
  fileName: string;
  status: "success" | "syncing" | "failed" | "stale";
  lastSyncedAt: string;
  message?: string;
};

export type ActivityFeedItem = {
  id: string;
  title: string;
  detail?: string;
  timestamp: string;
  status: "success" | "info" | "warning" | "neutral" | "error";
};

export type HomeDashboardWidgetsData = {
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
  recentlyUpdatedOpenings: [];
  topHiringCompanies: Array<{
    id: string;
    rank: number;
    name: string;
    openings: number;
    businessUnits: string[];
  }>;
  excelSyncStatus: ExcelSyncStatusItem[];
  activityFeed: ActivityFeedItem[];
  generatedAt: string;
};
