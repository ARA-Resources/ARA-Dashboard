/**
 * Mock Home dashboard widgets.
 * Swap `fetchHomeDashboardWidgets` in services/home to use Excel/API later —
 * do not hardcode these values inside React components.
 */
import type { HomeDashboardWidgetsData } from "@/types/home-widgets";

export const HOME_WIDGETS_MOCK: HomeDashboardWidgetsData = {
  generatedAt: "2026-08-06T07:30:00.000Z",
  metrics: {
    totalOpenPositions: {
      id: "total-open-positions",
      label: "Total Open Positions",
      value: 1284,
      description: "Across Lateral, Executive & Consulting",
      changePercent: 4.2,
      trend: "up",
    },
    activeOpenings: {
      id: "active-openings",
      label: "Active Openings",
      value: 902,
      description: "Currently in active hiring",
      changePercent: 1.8,
      trend: "up",
    },
    postedOpenings: {
      id: "posted-openings",
      label: "Posted Openings",
      value: 746,
      description: "Visible on career portals",
      changePercent: -0.6,
      trend: "down",
    },
    newOpenings: {
      id: "new-openings",
      label: "New Openings",
      value: 58,
      description: "Added in the last 7 days",
      changePercent: 12.4,
      trend: "up",
    },
  },
  metricBreakdown: {
    totalOpenPositions: [
      { businessUnitId: "lateral", name: "Lateral", value: 682 },
      { businessUnitId: "executive", name: "Executive", value: 214 },
      { businessUnitId: "consulting", name: "Consulting", value: 388 },
    ],
    activeOpenings: [
      { businessUnitId: "lateral", name: "Lateral", value: 486 },
      { businessUnitId: "executive", name: "Executive", value: 138 },
      { businessUnitId: "consulting", name: "Consulting", value: 278 },
    ],
    postedOpenings: [
      { businessUnitId: "lateral", name: "Lateral", value: 392 },
      { businessUnitId: "executive", name: "Executive", value: 122 },
      { businessUnitId: "consulting", name: "Consulting", value: 232 },
    ],
    newOpenings: [
      { businessUnitId: "lateral", name: "Lateral", value: 31 },
      { businessUnitId: "executive", name: "Executive", value: 9 },
      { businessUnitId: "consulting", name: "Consulting", value: 18 },
    ],
  },
  businessUnitDistribution: [
    {
      businessUnitId: "lateral",
      name: "Lateral",
      openings: 682,
      percent: 53.1,
    },
    {
      businessUnitId: "executive",
      name: "Executive",
      openings: 214,
      percent: 16.7,
    },
    {
      businessUnitId: "consulting",
      name: "Consulting",
      openings: 388,
      percent: 30.2,
    },
  ],
  recentlyUpdatedOpenings: [
    {
      id: "ru-1",
      title: "Senior Data Scientist – Generative AI",
      businessUnit: "Lateral",
      company: "Accenture",
      updatedAt: "2026-08-06T06:45:00.000Z",
      status: "new",
    },
    {
      id: "ru-2",
      title: "Managing Director – Strategy",
      businessUnit: "Executive",
      company: "Accenture",
      updatedAt: "2026-08-06T05:10:00.000Z",
      status: "active",
    },
    {
      id: "ru-3",
      title: "Technology Consulting Manager",
      businessUnit: "Consulting",
      company: "Accenture",
      updatedAt: "2026-08-05T18:20:00.000Z",
      status: "posted",
    },
    {
      id: "ru-4",
      title: "Lead ML Engineer – NLP",
      businessUnit: "Lateral",
      company: "Accenture",
      updatedAt: "2026-08-05T14:05:00.000Z",
      status: "active",
    },
    {
      id: "ru-5",
      title: "Associate Director – Cloud",
      businessUnit: "Executive",
      company: "Accenture",
      updatedAt: "2026-08-05T11:40:00.000Z",
      status: "posted",
    },
  ],
  topHiringCompanies: [
    {
      id: "hc-1",
      rank: 1,
      name: "Accenture",
      openings: 1284,
      businessUnits: ["Lateral", "Executive", "Consulting"],
    },
    {
      id: "hc-2",
      rank: 2,
      name: "Infosys",
      openings: 0,
      businessUnits: [],
    },
  ],
  excelSyncStatus: [
    {
      id: "sync-lateral",
      businessUnitId: "lateral",
      businessUnitName: "Lateral",
      fileName: "lateral-mastersheet.xlsm",
      status: "success",
      lastSyncedAt: "2026-08-06T07:15:00.000Z",
      message: "Synced 682 openings",
    },
    {
      id: "sync-executive",
      businessUnitId: "executive",
      businessUnitName: "Executive",
      fileName: "executive-mastersheet.xlsm",
      status: "success",
      lastSyncedAt: "2026-08-06T07:12:00.000Z",
      message: "Synced 214 openings",
    },
    {
      id: "sync-consulting",
      businessUnitId: "consulting",
      businessUnitName: "Consulting",
      fileName: "consulting-demand.xlsx",
      status: "stale",
      lastSyncedAt: "2026-08-05T19:40:00.000Z",
      message: "File older than expected refresh window",
    },
  ],
  activityFeed: [
    {
      id: "act-1",
      title: "Lateral Excel synced successfully",
      detail: "lateral-mastersheet.xlsm",
      timestamp: "2026-08-06T07:15:00.000Z",
      status: "success",
    },
    {
      id: "act-2",
      title: "Executive dashboard refreshed",
      detail: "214 openings loaded",
      timestamp: "2026-08-06T07:12:00.000Z",
      status: "info",
    },
    {
      id: "act-3",
      title: "5 new Lateral openings detected",
      timestamp: "2026-08-06T06:45:00.000Z",
      status: "success",
    },
    {
      id: "act-4",
      title: "Consulting sync marked stale",
      detail: "Refresh recommended",
      timestamp: "2026-08-06T06:00:00.000Z",
      status: "warning",
    },
    {
      id: "act-5",
      title: "Admin updated Accenture filters",
      timestamp: "2026-08-05T16:22:00.000Z",
      status: "neutral",
    },
  ],
};

/** Empty payload for empty-state testing / future zero-data Excel loads */
export const HOME_WIDGETS_EMPTY: HomeDashboardWidgetsData = {
  generatedAt: new Date().toISOString(),
  metrics: {
    totalOpenPositions: {
      id: "total-open-positions",
      label: "Total Open Positions",
      value: 0,
      description: "No openings available",
      changePercent: 0,
      trend: "flat",
    },
    activeOpenings: {
      id: "active-openings",
      label: "Active Openings",
      value: 0,
      description: "No active openings",
      changePercent: 0,
      trend: "flat",
    },
    postedOpenings: {
      id: "posted-openings",
      label: "Posted Openings",
      value: 0,
      description: "No posted openings",
      changePercent: 0,
      trend: "flat",
    },
    newOpenings: {
      id: "new-openings",
      label: "New Openings",
      value: 0,
      description: "No new openings",
      changePercent: 0,
      trend: "flat",
    },
  },
  metricBreakdown: {
    totalOpenPositions: [],
    activeOpenings: [],
    postedOpenings: [],
    newOpenings: [],
  },
  businessUnitDistribution: [],
  recentlyUpdatedOpenings: [],
  topHiringCompanies: [],
  excelSyncStatus: [],
  activityFeed: [],
};
