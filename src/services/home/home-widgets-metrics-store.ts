/**
 * Persistent lightweight Home Dashboard metrics snapshot.
 *
 * Phase 2: read by `getHomeDashboardWidgets` (Home request path).
 * Phase 3 (not yet): written after successful Dataset / Lateral sync.
 * Path: .data/home-widgets-metrics.json (plain JSON, no secrets).
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { BusinessUnitId } from "@/types/business-unit";
import { isPostgresMode } from "@/lib/persistence/persistence-mode";
import { getHomeMetricsStore } from "@/lib/persistence/store-factory";

const STORE_DIR = path.join(process.cwd(), ".data");
const STORE_PATH = path.join(STORE_DIR, "home-widgets-metrics.json");

export const HOME_WIDGETS_METRICS_STORE_VERSION = 1 as const;

export type HomeWidgetsMetricsSource =
  | "pipeline"
  | "bootstrap"
  | "manual"
  | "drive-xlsm"
  | "unknown";

export interface HomeUnitWidgetsMetrics {
  totals: number;
  active: number;
  posted: number;
  fresh: number;
  fileName: string;
  mtimeMs: number;
  source: HomeWidgetsMetricsSource;
  computedAt: string;
  error: string | null;
}

export interface HomeWidgetsMetricsSnapshot {
  version: typeof HOME_WIDGETS_METRICS_STORE_VERSION;
  updatedAt: string;
  units: Partial<Record<BusinessUnitId, HomeUnitWidgetsMetrics>>;
}

const BUSINESS_UNIT_IDS: BusinessUnitId[] = [
  "lateral",
  "executive",
  "consulting",
];

function emptySnapshot(updatedAt = new Date().toISOString()): HomeWidgetsMetricsSnapshot {
  return {
    version: HOME_WIDGETS_METRICS_STORE_VERSION,
    updatedAt,
    units: {},
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeSource(value: unknown): HomeWidgetsMetricsSource {
  if (
    value === "pipeline" ||
    value === "bootstrap" ||
    value === "manual" ||
    value === "drive-xlsm" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

/**
 * A unit snapshot is "valid" when it represents a successful computation.
 * Failed/empty error payloads must not replace a previously valid unit.
 */
export function isValidHomeUnitMetrics(
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

function normalizeUnit(
  raw: unknown
): HomeUnitWidgetsMetrics | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;

  const error =
    row.error === null || row.error === undefined
      ? null
      : typeof row.error === "string"
        ? row.error
        : String(row.error);

  const unit: HomeUnitWidgetsMetrics = {
    totals: isFiniteNumber(row.totals) ? row.totals : 0,
    active: isFiniteNumber(row.active) ? row.active : 0,
    posted: isFiniteNumber(row.posted) ? row.posted : 0,
    fresh: isFiniteNumber(row.fresh) ? row.fresh : 0,
    fileName: typeof row.fileName === "string" ? row.fileName : "",
    mtimeMs: isFiniteNumber(row.mtimeMs) ? row.mtimeMs : 0,
    source: normalizeSource(row.source),
    computedAt:
      typeof row.computedAt === "string" && row.computedAt.trim()
        ? row.computedAt
        : "",
    error,
  };

  return unit;
}

function parseSnapshot(raw: unknown): HomeWidgetsMetricsSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as Record<string, unknown>;
  if (parsed.version !== HOME_WIDGETS_METRICS_STORE_VERSION) return null;

  const units: HomeWidgetsMetricsSnapshot["units"] = {};
  const rawUnits =
    parsed.units && typeof parsed.units === "object"
      ? (parsed.units as Record<string, unknown>)
      : {};

  for (const id of BUSINESS_UNIT_IDS) {
    const unit = normalizeUnit(rawUnits[id]);
    if (unit) units[id] = unit;
  }

  return {
    version: HOME_WIDGETS_METRICS_STORE_VERSION,
    updatedAt:
      typeof parsed.updatedAt === "string" && parsed.updatedAt.trim()
        ? parsed.updatedAt
        : new Date().toISOString(),
    units,
  };
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  await fs.writeFile(tmpPath, payload, "utf8");
  try {
    await fs.rename(tmpPath, filePath);
  } catch {
    // Windows: rename cannot replace an existing file — copy then remove temp.
    await fs.copyFile(tmpPath, filePath);
    await fs.unlink(tmpPath).catch(() => undefined);
  }
}

/**
 * Read the Home metrics snapshot.
 * Missing or corrupt files return a safe empty snapshot (never throws).
 */
export async function readHomeWidgetsMetricsSnapshot(): Promise<HomeWidgetsMetricsSnapshot> {
  if (isPostgresMode()) return getHomeMetricsStore().readSnapshot();
  try {
    const raw = (await fs.readFile(STORE_PATH, "utf8")).replace(/^\uFEFF/, "");
    const parsed = parseSnapshot(JSON.parse(raw) as unknown);
    if (!parsed) return emptySnapshot();
    return parsed;
  } catch {
    return emptySnapshot();
  }
}

/**
 * Replace the entire snapshot on disk (atomic write).
 * Prefer {@link mergeHomeUnitWidgetsMetrics} for per-unit updates.
 */
export async function writeHomeWidgetsMetricsSnapshot(
  snapshot: HomeWidgetsMetricsSnapshot
): Promise<HomeWidgetsMetricsSnapshot> {
  if (isPostgresMode()) return getHomeMetricsStore().writeSnapshot(snapshot);
  const next: HomeWidgetsMetricsSnapshot = {
    version: HOME_WIDGETS_METRICS_STORE_VERSION,
    updatedAt: snapshot.updatedAt || new Date().toISOString(),
    units: {},
  };

  for (const id of BUSINESS_UNIT_IDS) {
    const unit = snapshot.units[id];
    if (unit) next.units[id] = { ...unit };
  }

  await atomicWriteJson(STORE_PATH, next);
  return next;
}

export type MergeHomeUnitMetricsInput = Omit<
  HomeUnitWidgetsMetrics,
  "error"
> & {
  /** Non-null means the computation failed — previous valid unit is preserved. */
  error?: string | null;
};

/**
 * Merge metrics for a single business unit.
 * - Successful valid metrics replace that unit only.
 * - Failed / invalid incoming metrics do NOT overwrite a previously valid unit.
 * - Other business units are always preserved.
 */
export async function mergeHomeUnitWidgetsMetrics(
  businessUnitId: BusinessUnitId,
  incoming: MergeHomeUnitMetricsInput
): Promise<HomeWidgetsMetricsSnapshot> {
  if (isPostgresMode()) return getHomeMetricsStore().mergeUnit(businessUnitId, incoming);
  const prior = await readHomeWidgetsMetricsSnapshot();
  const previous = prior.units[businessUnitId];

  const candidate: HomeUnitWidgetsMetrics = {
    totals: incoming.totals,
    active: incoming.active,
    posted: incoming.posted,
    fresh: incoming.fresh,
    fileName: incoming.fileName,
    mtimeMs: incoming.mtimeMs,
    source: normalizeSource(incoming.source),
    computedAt: incoming.computedAt,
    error:
      incoming.error === undefined || incoming.error === null
        ? null
        : String(incoming.error),
  };

  const nextUnits: HomeWidgetsMetricsSnapshot["units"] = {
    ...prior.units,
  };

  if (isValidHomeUnitMetrics(candidate)) {
    // Keep last non-zero Home KPIs until a newer sheet reports real counts.
    // All-zero snapshots must not wipe a previously populated dashboard.
    const incomingEmpty =
      candidate.totals === 0 &&
      candidate.active === 0 &&
      candidate.posted === 0 &&
      candidate.fresh === 0;
    const previousPopulated =
      isValidHomeUnitMetrics(previous) &&
      (previous.totals > 0 ||
        previous.active > 0 ||
        previous.posted > 0 ||
        previous.fresh > 0);
    nextUnits[businessUnitId] =
      incomingEmpty && previousPopulated ? previous! : candidate;
  } else if (isValidHomeUnitMetrics(previous)) {
    // Preserve last known good metrics for this unit.
    nextUnits[businessUnitId] = previous;
  } else if (previous) {
    // No prior valid snapshot — keep whatever was stored; do not invent zeros from a failure.
    nextUnits[businessUnitId] = previous;
  }
  // else: leave unit absent

  const next: HomeWidgetsMetricsSnapshot = {
    version: HOME_WIDGETS_METRICS_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    units: nextUnits,
  };

  await atomicWriteJson(STORE_PATH, next);
  return next;
}

/** Absolute path of the metrics file (for diagnostics / scripts). */
export function getHomeWidgetsMetricsStorePath(): string {
  return STORE_PATH;
}
