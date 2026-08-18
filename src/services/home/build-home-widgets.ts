/**
 * Home Dashboard widgets payload builder.
 *
 * Phase 2: reads lightweight metrics from `.data/home-widgets-metrics.json`.
 * Does NOT parse Lateral XLSM / Excel on the Home request path.
 *
 * `countOpeningsFromRows` is retained for Phase 3 (sync-time computation) —
 * it is not invoked from `getHomeDashboardWidgets`.
 */
import { BUSINESS_UNITS } from "@/constants/business-units";
import {
  isValidHomeUnitMetrics,
  readHomeWidgetsMetricsSnapshot,
  type HomeUnitWidgetsMetrics,
  type HomeWidgetsMetricsSnapshot,
} from "@/services/home/home-widgets-metrics-store";
import type { BusinessUnitId } from "@/types/business-unit";
import type {
  HomeDashboardWidgetsData,
  MetricWidgetData,
} from "@/types/home-widgets";

const BUSINESS_UNIT_IDS: BusinessUnitId[] = [
  "lateral",
  "executive",
  "consulting",
];

const CACHE_TTL_MS = 60_000;

type UnitMetricResult = {
  unitId: BusinessUnitId;
  mtimeMs: number;
  fileName: string;
  totals: number;
  active: number;
  posted: number;
  fresh: number;
  error: string | null;
  /** ISO timestamp from snapshot when available */
  computedAt: string | null;
  /** True when no snapshot unit exists yet (Phase 3 not run) */
  missingSnapshot: boolean;
};

type WidgetsCache = {
  key: string;
  at: number;
  payload: HomeDashboardWidgetsData;
};

let widgetsCache: WidgetsCache | null = null;

function toMetric(
  id: string,
  label: string,
  value: number,
  description: string
): MetricWidgetData {
  return {
    id,
    label,
    value,
    description,
    trend: "flat",
    changePercent: 0,
  };
}

function findHeader(headers: string[], patterns: RegExp[]) {
  for (const pattern of patterns) {
    const hit = headers.find((header) => pattern.test(header.trim()));
    if (hit) return hit;
  }
  return null;
}

function cellText(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Fast home metrics: header name match + one row pass.
 * Used at sync-time (Phase 3) and when refreshing from Drive Master.
 *
 * Lateral / Master Sheet rules (aligned with Accenture dashboard defaults):
 * - Total open = Active + New + Reopen (Closed excluded)
 * - Active = Active only
 * - Posted = open rows with Posted = Yes
 * - New / fresh = New only
 */
export function countOpeningsFromRows(
  headers: string[],
  rows: Array<Record<string, unknown>>
) {
  // P-Roles / pivot sheets: sum Grand Total when present.
  const grandHeader = findHeader(headers, [
    /^grand\s*total$/i,
    /total\s*openings?/i,
  ]);
  if (grandHeader) {
    let sum = 0;
    let hasNumeric = false;
    for (const row of rows) {
      const raw = row[grandHeader];
      const value =
        typeof raw === "number"
          ? raw
          : Number(String(raw ?? "").replace(/,/g, ""));
      if (!Number.isFinite(value)) continue;
      hasNumeric = true;
      sum += value;
    }
    if (hasNumeric) {
      return { totals: sum, active: sum, posted: sum, fresh: 0 };
    }
  }

  const statusColumn = findHeader(headers, [
    /^job\s*status$/i,
    /^opening\s*status$/i,
    /^status$/i,
    /status/i,
  ]);
  const postedColumn = findHeader(headers, [/^posted$/i, /posted/i]);

  if (!statusColumn) {
    const rowTotal = rows.length;
    return {
      totals: rowTotal,
      active: rowTotal,
      posted: rowTotal,
      fresh: 0,
    };
  }

  let totals = 0;
  let active = 0;
  let posted = 0;
  let fresh = 0;

  for (const row of rows) {
    const status = cellText(row[statusColumn]);
    const isActive = status === "active";
    const isNew = status === "new";
    const isReopen = status === "reopen";
    if (!isActive && !isNew && !isReopen) continue;

    totals += 1;
    if (isActive) active += 1;
    if (isNew) fresh += 1;

    const postedValue = postedColumn ? cellText(row[postedColumn]) : "yes";
    const isPosted = !postedColumn || postedValue === "yes";
    if (isPosted) posted += 1;
  }

  // If Status exists but no open values (vendor DS), fall back to row count.
  if (totals === 0 && active === 0 && fresh === 0) {
    const rowTotal = rows.length;
    return {
      totals: rowTotal,
      active: rowTotal,
      posted: rowTotal,
      fresh: 0,
    };
  }

  return { totals, active, posted, fresh };
}

function emptyUnitResult(unitId: BusinessUnitId): UnitMetricResult {
  return {
    unitId,
    mtimeMs: 0,
    fileName: "—",
    totals: 0,
    active: 0,
    posted: 0,
    fresh: 0,
    error: null,
    computedAt: null,
    missingSnapshot: true,
  };
}

function unitFromSnapshot(
  unitId: BusinessUnitId,
  unit: HomeUnitWidgetsMetrics | undefined
): UnitMetricResult {
  if (!unit) return emptyUnitResult(unitId);

  if (isValidHomeUnitMetrics(unit)) {
    return {
      unitId,
      mtimeMs: unit.mtimeMs,
      fileName: unit.fileName || "—",
      totals: unit.totals,
      active: unit.active,
      posted: unit.posted,
      fresh: unit.fresh,
      error: null,
      computedAt: unit.computedAt,
      missingSnapshot: false,
    };
  }

  // Stored but invalid / error — still do not parse Excel; surface message if any.
  return {
    unitId,
    mtimeMs: unit.mtimeMs || 0,
    fileName: unit.fileName || "—",
    totals: 0,
    active: 0,
    posted: 0,
    fresh: 0,
    error: unit.error?.trim()
      ? unit.error
      : "Home metrics snapshot for this unit is incomplete.",
    computedAt: unit.computedAt || null,
    missingSnapshot: false,
  };
}

function unitResultsFromSnapshot(
  snapshot: HomeWidgetsMetricsSnapshot
): UnitMetricResult[] {
  return BUSINESS_UNIT_IDS.map((unitId) =>
    unitFromSnapshot(unitId, snapshot.units[unitId])
  );
}

function snapshotCacheKey(snapshot: HomeWidgetsMetricsSnapshot): string {
  const parts = BUSINESS_UNIT_IDS.map((id) => {
    const unit = snapshot.units[id];
    if (!unit) return `${id}:missing`;
    return `${id}:${unit.computedAt || "na"}:${unit.mtimeMs}:${unit.totals}:${unit.active}:${unit.posted}:${unit.fresh}:${unit.error ?? ""}`;
  });
  return `${snapshot.updatedAt}|${parts.join("|")}`;
}

function buildPayload(
  unitResults: UnitMetricResult[],
  generatedAt: string
): HomeDashboardWidgetsData {
  const totalsByUnit = new Map<BusinessUnitId, number>();
  const activeByUnit = new Map<BusinessUnitId, number>();
  const postedByUnit = new Map<BusinessUnitId, number>();
  const freshByUnit = new Map<BusinessUnitId, number>();
  const mtimeByUnit = new Map<BusinessUnitId, number>();
  const fileNameByUnit = new Map<BusinessUnitId, string>();
  const errorByUnit = new Map<BusinessUnitId, string>();
  const computedAtByUnit = new Map<BusinessUnitId, string>();
  const missingByUnit = new Map<BusinessUnitId, boolean>();

  for (const result of unitResults) {
    totalsByUnit.set(result.unitId, result.totals);
    activeByUnit.set(result.unitId, result.active);
    postedByUnit.set(result.unitId, result.posted);
    freshByUnit.set(result.unitId, result.fresh);
    mtimeByUnit.set(result.unitId, result.mtimeMs);
    fileNameByUnit.set(result.unitId, result.fileName);
    missingByUnit.set(result.unitId, result.missingSnapshot);
    if (result.computedAt) computedAtByUnit.set(result.unitId, result.computedAt);
    if (result.error) errorByUnit.set(result.unitId, result.error);
  }

  const unitMeta = BUSINESS_UNITS.filter((unit) =>
    BUSINESS_UNIT_IDS.includes(unit.id as BusinessUnitId)
  );

  const totalOpenPositions = unitMeta.reduce(
    (sum, unit) => sum + (totalsByUnit.get(unit.id) ?? 0),
    0
  );
  const activeOpenings = unitMeta.reduce(
    (sum, unit) => sum + (activeByUnit.get(unit.id) ?? 0),
    0
  );
  const postedOpenings = unitMeta.reduce(
    (sum, unit) => sum + (postedByUnit.get(unit.id) ?? 0),
    0
  );
  const newOpenings = unitMeta.reduce(
    (sum, unit) => sum + (freshByUnit.get(unit.id) ?? 0),
    0
  );

  const syncStatus = unitMeta.map((unit) => {
    const mtime = mtimeByUnit.get(unit.id);
    const unitError = errorByUnit.get(unit.id);
    const missing = missingByUnit.get(unit.id) === true;
    const unitGeneratedAt =
      computedAtByUnit.get(unit.id) ?? generatedAt;
    const fileUpdatedLabel =
      mtime && mtime > 0
        ? `File updated ${new Date(mtime).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}`
        : null;

    if (missing) {
      return {
        id: `sync-${unit.id}`,
        businessUnitId: unit.id,
        businessUnitName: unit.name,
        fileName: fileNameByUnit.get(unit.id) ?? unit.excel.sourceLabel,
        status: "stale" as const,
        lastSyncedAt: unitGeneratedAt,
        message:
          "Home metrics snapshot not available yet. Metrics will appear after the next successful Dataset sync.",
      };
    }

    return {
      id: `sync-${unit.id}`,
      businessUnitId: unit.id,
      businessUnitName: unit.name,
      fileName: fileNameByUnit.get(unit.id) ?? unit.excel.sourceLabel,
      status: unitError ? ("failed" as const) : ("success" as const),
      lastSyncedAt: unitGeneratedAt,
      message: unitError
        ? unitError
        : [
            `Loaded ${totalsByUnit.get(unit.id) ?? 0} openings`,
            "Home metrics snapshot",
            fileUpdatedLabel,
          ]
            .filter(Boolean)
            .join(" · "),
    };
  });

  return {
    generatedAt,
    metrics: {
      totalOpenPositions: toMetric(
        "total-open-positions",
        "Total Open Positions",
        totalOpenPositions,
        "Across Lateral, Executive & Consulting"
      ),
      activeOpenings: toMetric(
        "active-openings",
        "Active Openings",
        activeOpenings,
        "Currently in active hiring"
      ),
      postedOpenings: toMetric(
        "posted-openings",
        "Posted Openings",
        postedOpenings,
        "Visible on career portals"
      ),
      newOpenings: toMetric(
        "new-openings",
        "New Openings",
        newOpenings,
        "Added from latest sheet updates"
      ),
    },
    metricBreakdown: {
      totalOpenPositions: unitMeta.map((unit) => ({
        businessUnitId: unit.id,
        name: unit.name,
        value: totalsByUnit.get(unit.id) ?? 0,
      })),
      activeOpenings: unitMeta.map((unit) => ({
        businessUnitId: unit.id,
        name: unit.name,
        value: activeByUnit.get(unit.id) ?? 0,
      })),
      postedOpenings: unitMeta.map((unit) => ({
        businessUnitId: unit.id,
        name: unit.name,
        value: postedByUnit.get(unit.id) ?? 0,
      })),
      newOpenings: unitMeta.map((unit) => ({
        businessUnitId: unit.id,
        name: unit.name,
        value: freshByUnit.get(unit.id) ?? 0,
      })),
    },
    businessUnitDistribution: unitMeta.map((unit) => {
      const openings = totalsByUnit.get(unit.id) ?? 0;
      return {
        businessUnitId: unit.id,
        name: unit.name,
        openings,
        percent:
          totalOpenPositions > 0 ? (openings / totalOpenPositions) * 100 : 0,
      };
    }),
    recentlyUpdatedOpenings: [],
    topHiringCompanies: [
      {
        id: "hc-1",
        rank: 1,
        name: "Accenture",
        openings: totalOpenPositions,
        businessUnits: unitMeta.map((unit) => unit.name),
      },
    ],
    excelSyncStatus: syncStatus,
    activityFeed: syncStatus.map((item) => ({
      id: `activity-${item.businessUnitId}`,
      title: `${item.businessUnitName} Excel synced`,
      detail: item.fileName,
      timestamp: item.lastSyncedAt,
      status:
        item.status === "failed"
          ? ("error" as const)
          : item.status === "stale"
            ? ("warning" as const)
            : ("success" as const),
    })),
  };
}

/**
 * Home widgets data for `/api/home/widgets`.
 * L1: in-memory widgetsCache · L2: `.data/home-widgets-metrics.json`
 * Never parses Excel workbooks.
 */
export async function getHomeDashboardWidgets(options?: {
  bypassCache?: boolean;
}): Promise<HomeDashboardWidgetsData> {
  const snapshot = await readHomeWidgetsMetricsSnapshot();
  const cacheKey = snapshotCacheKey(snapshot);

  if (
    !options?.bypassCache &&
    widgetsCache &&
    widgetsCache.key === cacheKey &&
    Date.now() - widgetsCache.at < CACHE_TTL_MS
  ) {
    return widgetsCache.payload;
  }

  const unitResults = unitResultsFromSnapshot(snapshot);
  const generatedAt = snapshot.updatedAt || new Date().toISOString();
  const payload = buildPayload(unitResults, generatedAt);
  widgetsCache = { key: cacheKey, at: Date.now(), payload };
  return payload;
}

export function invalidateHomeWidgetsCache() {
  widgetsCache = null;
}
