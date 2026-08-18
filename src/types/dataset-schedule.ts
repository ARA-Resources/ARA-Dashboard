import { DATASET_SYNC_NAMES, type DatasetSyncName } from "@/types/dataset-sync";
import { EXECUTABLE_DATASET_TYPES } from "@/types/dataset-execution";

export type ScheduleFrequency =
  | "daily"
  | "weekdays"
  | "weekly"
  | "hourly"
  | "custom";

export type ScheduleRunStatus =
  | "success"
  | "partial"
  | "failed"
  | "skipped"
  | null;

/**
 * One automation schedule. Unlimited schedules supported.
 * Each schedule can target one or more datasets.
 */
export interface DatasetAutomationSchedule {
  id: string;
  name: string;
  frequency: ScheduleFrequency;
  /** HH:mm — used for daily / weekdays / weekly (and as fallback for custom) */
  syncTime: string;
  /** 0=Sunday … 6=Saturday — used when frequency is weekly (default Monday=1) */
  dayOfWeek: number;
  /**
   * Custom frequency: selected weekdays (0=Sun … 6=Sat).
   * Example: [1, 3, 5] = Mon, Wed, Fri.
   */
  customDays: number[];
  /**
   * Custom frequency: one or more HH:mm run times.
   * Example: ["07:00", "14:00"].
   */
  customTimes: string[];
  /**
   * @deprecated Legacy cron string — migrated to custom days/times on read
   */
  customCron?: string;
  /** Datasets included in this run. Empty = all enabled datasets. */
  datasetNames: DatasetSyncName[];
  enabled: boolean;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: ScheduleRunStatus;
  lastRunMessage: string | null;
  lastDurationMs: number | null;
}

export interface DatasetAutomationScheduleView extends DatasetAutomationSchedule {
  /** Primary / combined cron preview */
  cronExpression: string;
  /** All armed expressions (custom may have several) */
  cronExpressions: string[];
  nextRunAt: string | null;
  statusLabel: "Active" | "Paused" | "Disabled";
  timeLabel: string;
  datasetsLabel: string;
}

export interface DatasetSchedulesStore {
  version: 1;
  updatedAt: string;
  schedules: DatasetAutomationSchedule[];
}

export interface MultiSchedulerStatus {
  enabled: boolean;
  /** True when every schedule is paused or global pause is on */
  paused: boolean;
  globalPaused: boolean;
  running: boolean;
  runningScheduleId: string | null;
  timezone: string;
  scheduleCount: number;
  activeCount: number;
  startedAt: string | null;
  schedules: DatasetAutomationScheduleView[];
  /** Backward-compatible summary fields */
  cronExpression: string | null;
  syncFrequency: string | null;
  syncTime: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: ScheduleRunStatus;
  lastRunMessage: string | null;
  lastError: string | null;
}

export const SCHEDULE_FREQUENCY_LABELS: Record<ScheduleFrequency, string> = {
  daily: "Every Day",
  weekdays: "Weekdays",
  weekly: "Weekly",
  hourly: "Every Hour",
  custom: "Custom",
};

export const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const WEEKDAY_SHORT_LABELS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

/** Default custom = weekdays at 07:00 */
export const DEFAULT_CUSTOM_DAYS = [1, 2, 3, 4, 5];
export const DEFAULT_CUSTOM_TIMES = ["07:00"];

export function normalizeHhMm(value: string, fallback = "07:00"): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return fallback;
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function normalizeCustomDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [...DEFAULT_CUSTOM_DAYS];
  const days = value
    .map((item) => Number(item))
    .filter((day) => Number.isFinite(day) && day >= 0 && day <= 6)
    .map((day) => Math.floor(day));
  return Array.from(new Set(days)).sort((a, b) => a - b);
}

export function normalizeCustomTimes(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_CUSTOM_TIMES];
  const times = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalizeHhMm(item))
    .filter(Boolean);
  return Array.from(new Set(times)).sort();
}

/**
 * Best-effort parse of a legacy 5-field cron into days + times.
 * Falls back to weekdays @ 07:00 when parsing fails.
 */
export function parseLegacyCronToCustom(expression: string): {
  customDays: number[];
  customTimes: string[];
} {
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5) {
    return {
      customDays: [...DEFAULT_CUSTOM_DAYS],
      customTimes: [...DEFAULT_CUSTOM_TIMES],
    };
  }
  const [minPart, hourPart, , , dowPart] = parts;
  const minutes = minPart.split(",").map(Number).filter(Number.isFinite);
  const hours = hourPart.split(",").map(Number).filter(Number.isFinite);

  let customDays: number[];
  if (!dowPart || dowPart === "*") {
    customDays = [0, 1, 2, 3, 4, 5, 6];
  } else if (dowPart === "1-5") {
    customDays = [...DEFAULT_CUSTOM_DAYS];
  } else {
    customDays = normalizeCustomDays(
      dowPart.split(",").flatMap((token) => {
        const range = /^(\d)-(\d)$/.exec(token);
        if (range) {
          const from = Number(range[1]);
          const to = Number(range[2]);
          const out: number[] = [];
          for (let d = from; d <= to; d += 1) out.push(d);
          return out;
        }
        return [Number(token)];
      })
    );
  }

  const customTimes: string[] = [];
  if (hours.length && minutes.length) {
    for (const hour of hours) {
      for (const minute of minutes) {
        if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
          customTimes.push(
            `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
          );
        }
      }
    }
  }

  return {
    customDays: customDays.length ? customDays : [...DEFAULT_CUSTOM_DAYS],
    customTimes: customTimes.length
      ? Array.from(new Set(customTimes)).sort()
      : [...DEFAULT_CUSTOM_TIMES],
  };
}

export function createEmptySchedule(
  partial?: Partial<DatasetAutomationSchedule>
): DatasetAutomationSchedule {
  const now = new Date().toISOString();
  return {
    id: partial?.id ?? cryptoRandomId(),
    name: partial?.name ?? "Daily sync",
    frequency: partial?.frequency ?? "daily",
    syncTime: partial?.syncTime ?? "07:00",
    dayOfWeek: partial?.dayOfWeek ?? 1,
    customDays: partial?.customDays ?? [...DEFAULT_CUSTOM_DAYS],
    customTimes: partial?.customTimes ?? [...DEFAULT_CUSTOM_TIMES],
    datasetNames: partial?.datasetNames ?? [...EXECUTABLE_DATASET_TYPES],
    enabled: partial?.enabled ?? true,
    paused: partial?.paused ?? false,
    createdAt: partial?.createdAt ?? now,
    updatedAt: partial?.updatedAt ?? now,
    lastRunAt: partial?.lastRunAt ?? null,
    lastRunStatus: partial?.lastRunStatus ?? null,
    lastRunMessage: partial?.lastRunMessage ?? null,
    lastDurationMs: partial?.lastDurationMs ?? null,
  };
}

function cryptoRandomId() {
  return `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function formatScheduleTimeLabel(
  schedule: Pick<
    DatasetAutomationSchedule,
    "frequency" | "syncTime" | "dayOfWeek" | "customDays" | "customTimes"
  >
): string {
  if (schedule.frequency === "hourly") return "Every hour";
  if (schedule.frequency === "custom") {
    const days =
      schedule.customDays?.length === 7
        ? "Every day"
        : schedule.customDays?.length
          ? schedule.customDays
              .map((d) => WEEKDAY_SHORT_LABELS[d] ?? String(d))
              .join(", ")
          : "No days";
    const times =
      schedule.customTimes?.length > 0
        ? schedule.customTimes.join(", ")
        : schedule.syncTime || "—";
    return `${days} · ${times}`;
  }
  if (schedule.frequency === "weekly") {
    const day = WEEKDAY_LABELS[schedule.dayOfWeek] ?? "Monday";
    return `Every ${day} · ${schedule.syncTime}`;
  }
  if (schedule.frequency === "weekdays") {
    return `Weekdays · ${schedule.syncTime}`;
  }
  return `Every day · ${schedule.syncTime}`;
}

export function formatDatasetsLabel(
  datasetNames: DatasetSyncName[] | undefined
): string {
  if (!datasetNames?.length || datasetNames.length === DATASET_SYNC_NAMES.length) {
    return "All datasets";
  }
  return datasetNames.join(", ");
}
