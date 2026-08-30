/**
 * Stage 10: Home dashboard widgets from PostgreSQL `home_metrics` only.
 *
 * Ports the Next.js postgres-mode path of getHomeDashboardWidgets:
 *   read home_metrics → unitResultsFromSnapshot → buildPayload
 *
 * Intentionally omitted: Drive/Excel/file bootstrap and all DB writes.
 */
import { queryRows } from "../db.js";
import type {
  ActivityFeedItem,
  BusinessUnitId,
  ExcelSyncStatusItem,
  HomeDashboardWidgetsData,
  MetricWidgetData,
} from "../types/home-widgets.js";

const BUSINESS_UNIT_IDS: BusinessUnitId[] = [
  "lateral",
  "executive",
  "consulting",
];

/** Minimal registry fields needed for payload labels (matches Next BUSINESS_UNITS). */
const BUSINESS_UNIT_META: Array<{
  id: BusinessUnitId;
  name: string;
  sourceLabel: string;
}> = [
  {
    id: "lateral",
    name: "Lateral",
    sourceLabel:
      "Google Drive XLSM · Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm · Master Sheet → openings",
  },
  {
    id: "executive",
    name: "Executive",
    sourceLabel: "Local/Drive Executive XLSM · Master Sheet → P - Dashboard",
  },
  {
    id: "consulting",
    name: "Consulting",
    sourceLabel: "Consulting Dataset (Dataset Manager)",
  },
];

const CACHE_TTL_MS = 60_000;

type HomeUnitWidgetsMetrics = {
  totals: number;
  active: number;
  posted: number;
  fresh: number;
  fileName: string;
  mtimeMs: number;
  source: string;
  computedAt: string;
  error: string | null;
};

type HomeWidgetsMetricsSnapshot = {
  version: 1;
  updatedAt: string;
  units: Partial<Record<BusinessUnitId, HomeUnitWidgetsMetrics>>;
};

type UnitMetricResult = {
  unitId: BusinessUnitId;
  mtimeMs: number;
  fileName: string;
  totals: number;
  active: number;
  posted: number;
  fresh: number;
  error: string | null;
  computedAt: string | null;
  missingSnapshot: boolean;
};

type WidgetsCache = {
  key: string;
  at: number;
  payload: HomeDashboardWidgetsData;
};

let widgetsCache: WidgetsCache | null = null;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidHomeUnitMetrics(
  unit: HomeUnitWidgetsMetrics | null | undefined
): boolean {
  if (!unit) return false;
  if (unit.error != null && String(unit.error).trim().length > 0) {
    return false;
  }
  if (!isFiniteNumber(unit.totals)) return false;
  if (!isFiniteNumber(unit.active)) return false;
  if (!isFiniteNumber(unit.posted)) return false;
  if (!isFiniteNumber(unit.fresh)) return false;
  if (!isFiniteNumber(unit.mtimeMs)) return false;
  if (typeof unit.fileName !== "string") return false;
  if (typeof unit.computedAt !== "string" || !unit.computedAt.trim()) {
    return false;
  }
  return true;
}

function toNumber(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function rowToUnit(row: Record<string, unknown>): HomeUnitWidgetsMetrics {
  return {
    totals: toNumber(row.totals),
    active: toNumber(row.active),
    posted: toNumber(row.posted),
    fresh: toNumber(row.fresh),
    fileName: typeof row.file_name === "string" ? row.file_name : "",
    mtimeMs: toNumber(row.mtime_ms),
    source: typeof row.source === "string" ? row.source : "unknown",
    computedAt:
      row.computed_at instanceof Date
        ? row.computed_at.toISOString()
        : typeof row.computed_at === "string"
          ? row.computed_at
          : "",
    error: typeof row.error === "string" ? row.error : null,
  };
}

/**
 * Matches PostgresHomeMetricsStore.readSnapshot() (read-only).
 * updatedAt is set at read time — same as Next postgres store.
 */
async function readHomeMetricsSnapshot(): Promise<HomeWidgetsMetricsSnapshot> {
  const rows = await queryRows<Record<string, unknown>>(
    `SELECT
       business_unit_id,
       totals,
       active,
       posted,
       fresh,
       file_name,
       mtime_ms,
       source,
       computed_at,
       error
     FROM home_metrics
     WHERE business_unit_id = ANY($1::text[])`,
    [BUSINESS_UNIT_IDS]
  );

  const units: HomeWidgetsMetricsSnapshot["units"] = {};
  for (const row of rows) {
    const id = row.business_unit_id as BusinessUnitId;
    if (
      id === "lateral" ||
      id === "executive" ||
      id === "consulting"
    ) {
      units[id] = rowToUnit(row);
    }
  }

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    units,
  };
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

  return {
    unitId,
    mtimeMs: unit.mtimeMs || 0,
    fileName: unit.fileName || "—",
    totals: unit.totals,
    active: unit.active,
    posted: unit.posted,
    fresh: unit.fresh,
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

  const unitMeta = BUSINESS_UNIT_META;

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

  const syncStatus: ExcelSyncStatusItem[] = unitMeta.map((unit) => {
    const mtime = mtimeByUnit.get(unit.id);
    const unitError = errorByUnit.get(unit.id);
    const missing = missingByUnit.get(unit.id) === true;
    const unitGeneratedAt = computedAtByUnit.get(unit.id) ?? generatedAt;
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
        fileName: fileNameByUnit.get(unit.id) ?? unit.sourceLabel,
        status: "stale" as const,
        lastSyncedAt: unitGeneratedAt,
        message:
          "Waiting for Master Sheet metrics. Connect Gmail/Drive or open Home again after OAuth so KPIs can load from Drive.",
      };
    }

    return {
      id: `sync-${unit.id}`,
      businessUnitId: unit.id,
      businessUnitName: unit.name,
      fileName: fileNameByUnit.get(unit.id) ?? unit.sourceLabel,
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

  const activityFeed: ActivityFeedItem[] = syncStatus.map((item) => ({
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
  }));

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
    activityFeed,
  };
}

export async function getHomeDashboardWidgets(options?: {
  bypassCache?: boolean;
}): Promise<HomeDashboardWidgetsData> {
  const snapshot = await readHomeMetricsSnapshot();
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
