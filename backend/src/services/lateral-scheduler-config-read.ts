/**
 * Stage 24: strictly read-only lateral scheduler config reader.
 * No INSERT/UPDATE/DELETE, no cron imports, no scheduler bootstrap.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { repoDataDir } from "../config/repo-root.js";
import { isPostgresMode } from "../config/persistence-mode.js";
import { queryRows } from "../db.js";
import {
  DEFAULT_CUSTOM_DAYS,
  DEFAULT_CUSTOM_TIMES,
  DEFAULT_LATERAL_TIMEZONE,
  normalizeCustomDays,
  normalizeCustomTimes,
  normalizeHhMm,
  type ScheduleFrequency,
} from "../types/lateral-processing-setup.js";

export type LateralJobStatus = "success" | "partial" | "failed";
export type LateralJobTrigger = "scheduler" | "manual";

export interface LateralSchedulerConfig {
  version: 1;
  frequency: ScheduleFrequency;
  syncTime: string;
  dayOfWeek: number;
  customDays: number[];
  customTimes: string[];
  timezone: string;
  enabled: boolean;
  paused: boolean;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: LateralJobStatus | null;
  lastRunMessage: string | null;
  lastDurationMs: number | null;
  lastTrigger: LateralJobTrigger | null;
}

const STORE_FILE = "lateral-scheduler.json";

/**
 * Logical scheduler defaults when PostgreSQL has no row — matches
 * `INSERT INTO lateral_scheduler_state DEFAULT VALUES` column defaults
 * from db/migrations/001_initial_schema.sql (read-only; no INSERT).
 */
const POSTGRES_MISSING_ROW_DEFAULTS: Record<string, unknown> = {
  frequency: "daily",
  sync_time: "07:00",
  day_of_week: 1,
  custom_days: [1, 2, 3, 4, 5],
  custom_times: ["09:00", "11:00"],
  timezone: DEFAULT_LATERAL_TIMEZONE,
  enabled: true,
  paused: false,
  last_run_at: null,
  last_run_status: null,
  last_run_message: null,
  last_duration_ms: null,
  last_trigger: null,
};

function validateTimezone(timezone: string): string {
  const next = timezone.trim() || DEFAULT_LATERAL_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: next }).format(new Date());
    return next;
  } catch {
    return DEFAULT_LATERAL_TIMEZONE;
  }
}

function normalizeFrequency(value: unknown): ScheduleFrequency {
  if (
    value === "hourly" ||
    value === "daily" ||
    value === "weekdays" ||
    value === "weekly" ||
    value === "custom"
  ) {
    return value;
  }
  return "daily";
}

function normalizeJobStatus(value: unknown): LateralJobStatus | null {
  if (value === "success" || value === "partial" || value === "failed") {
    return value;
  }
  return null;
}

function normalizeJobTrigger(value: unknown): LateralJobTrigger | null {
  if (value === "scheduler" || value === "manual") return value;
  return null;
}

function emptyConfig(): LateralSchedulerConfig {
  return {
    version: 1,
    frequency: "daily",
    syncTime: "07:00",
    dayOfWeek: 1,
    customDays: [...DEFAULT_CUSTOM_DAYS],
    customTimes: [...DEFAULT_CUSTOM_TIMES],
    timezone: DEFAULT_LATERAL_TIMEZONE,
    enabled: true,
    paused: false,
    updatedAt: new Date().toISOString(),
    lastRunAt: null,
    lastRunStatus: null,
    lastRunMessage: null,
    lastDurationMs: null,
    lastTrigger: null,
  };
}

function normalizeConfig(
  parsed: Partial<LateralSchedulerConfig>
): LateralSchedulerConfig {
  const base = emptyConfig();
  const syncTime = normalizeHhMm(parsed.syncTime || base.syncTime);
  const customTimes = normalizeCustomTimes(
    Array.isArray(parsed.customTimes) && parsed.customTimes.length
      ? parsed.customTimes
      : [syncTime]
  );
  return {
    ...base,
    ...parsed,
    version: 1,
    frequency: normalizeFrequency(parsed.frequency),
    syncTime,
    dayOfWeek: (() => {
      const raw = Number(parsed.dayOfWeek);
      return Number.isFinite(raw)
        ? Math.min(6, Math.max(0, Math.floor(raw)))
        : 1;
    })(),
    customDays: normalizeCustomDays(parsed.customDays),
    customTimes,
    timezone: validateTimezone(parsed.timezone || base.timezone),
    enabled: parsed.enabled !== false,
    paused: Boolean(parsed.paused),
    updatedAt:
      typeof parsed.updatedAt === "string" ? parsed.updatedAt : base.updatedAt,
    lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : null,
    lastRunStatus: normalizeJobStatus(parsed.lastRunStatus),
    lastRunMessage:
      typeof parsed.lastRunMessage === "string" ? parsed.lastRunMessage : null,
    lastDurationMs:
      typeof parsed.lastDurationMs === "number" ? parsed.lastDurationMs : null,
    lastTrigger: normalizeJobTrigger(parsed.lastTrigger),
  };
}

function rowToLateralSchedulerConfig(
  row: Record<string, unknown>
): LateralSchedulerConfig {
  return {
    version: 1,
    frequency: normalizeFrequency(row.frequency),
    syncTime: typeof row.sync_time === "string" ? row.sync_time : "07:00",
    dayOfWeek: typeof row.day_of_week === "number" ? row.day_of_week : 1,
    customDays: Array.isArray(row.custom_days)
      ? (row.custom_days as number[])
      : [...DEFAULT_CUSTOM_DAYS],
    customTimes: Array.isArray(row.custom_times)
      ? (row.custom_times as string[])
      : ["09:00"],
    timezone:
      typeof row.timezone === "string" ? row.timezone : DEFAULT_LATERAL_TIMEZONE,
    enabled: row.enabled === true,
    paused: row.paused === true,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : typeof row.updated_at === "string"
          ? row.updated_at
          : new Date().toISOString(),
    lastRunAt:
      row.last_run_at instanceof Date
        ? row.last_run_at.toISOString()
        : typeof row.last_run_at === "string"
          ? row.last_run_at
          : null,
    lastRunStatus: normalizeJobStatus(row.last_run_status),
    lastRunMessage:
      typeof row.last_run_message === "string" ? row.last_run_message : null,
    lastDurationMs:
      typeof row.last_duration_ms === "number" ? row.last_duration_ms : null,
    lastTrigger: normalizeJobTrigger(row.last_trigger),
  };
}

function missingFileModeSchedulerConfig(): LateralSchedulerConfig {
  return normalizeConfig({});
}

function missingPostgresSchedulerConfig(): LateralSchedulerConfig {
  return rowToLateralSchedulerConfig(POSTGRES_MISSING_ROW_DEFAULTS);
}

async function readLateralSchedulerConfigFromPostgres(): Promise<LateralSchedulerConfig> {
  try {
    const rows = await queryRows<Record<string, unknown>>(
      "SELECT * FROM lateral_scheduler_state ORDER BY id LIMIT 1"
    );
    if (!rows[0]) {
      return missingPostgresSchedulerConfig();
    }
    return rowToLateralSchedulerConfig(rows[0]);
  } catch {
    return missingPostgresSchedulerConfig();
  }
}

async function readLateralSchedulerConfigFromFile(): Promise<LateralSchedulerConfig> {
  try {
    const raw = await fs.readFile(
      path.join(repoDataDir(), STORE_FILE),
      "utf8"
    );
    const parsed = JSON.parse(raw) as Partial<LateralSchedulerConfig>;
    return normalizeConfig(parsed);
  } catch {
    return missingFileModeSchedulerConfig();
  }
}

/**
 * Read lateral scheduler config without writes or scheduler side effects.
 */
export async function readLateralSchedulerConfig(): Promise<LateralSchedulerConfig> {
  if (isPostgresMode()) {
    return readLateralSchedulerConfigFromPostgres();
  }
  return readLateralSchedulerConfigFromFile();
}
