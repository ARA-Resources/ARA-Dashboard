/**
 * Executive scheduler config persistence (Phase E1 — foundations only).
 *
 * Mirrors the non-cron half of `lateral-scheduler.ts`
 * (`readLateralSchedulerConfig` / `writeLateralSchedulerConfig` /
 * `normalizeConfig` / `emptyConfig`). No node-cron, no job execution, no
 * bootstrap wiring here — that lands in Phase E5 (`executive-scheduler.ts`),
 * which will import this module the same way `lateral-scheduler.ts` owns
 * its own config helpers.
 *
 * Fully independent of `lateral-scheduler.ts` / `lateral_scheduler_state`:
 * separate table (`executive_scheduler_state`), separate file-mode path,
 * separate in-memory nothing (no module state here at all yet).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isPostgresMode } from "@/lib/persistence/persistence-mode";
import { getSchedulerStateStore } from "@/lib/persistence/store-factory";
import type { ScheduleFrequency } from "@/types/dataset-schedule";
import {
  DEFAULT_CUSTOM_DAYS,
  DEFAULT_CUSTOM_TIMES,
  normalizeCustomDays,
  normalizeCustomTimes,
  normalizeHhMm,
} from "@/types/dataset-schedule";
import {
  DEFAULT_EXECUTIVE_TIMEZONE,
  type ExecutiveRunLastSummary,
  type ExecutiveSchedulerConfig,
} from "@/types/executive-scheduler";

const STORE_PATH = path.join(
  process.cwd(),
  ".data",
  "executive-scheduler.json"
);

function validateTimezone(timezone: string): string {
  const next = timezone.trim() || DEFAULT_EXECUTIVE_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: next }).format(new Date());
    return next;
  } catch {
    return DEFAULT_EXECUTIVE_TIMEZONE;
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

export function emptyExecutiveSchedulerConfig(): ExecutiveSchedulerConfig {
  return {
    version: 1,
    frequency: "daily",
    syncTime: "07:00",
    dayOfWeek: 1,
    customDays: [...DEFAULT_CUSTOM_DAYS],
    customTimes: [...DEFAULT_CUSTOM_TIMES],
    timezone: DEFAULT_EXECUTIVE_TIMEZONE,
    // Phase E5: defaults FALSE (unlike Lateral's emptyConfig(), which defaults
    // true) — a fresh Executive install must never auto-fire without an
    // explicit enable step. Matches migration 010's enabled DEFAULT FALSE.
    enabled: false,
    paused: false,
    updatedAt: new Date().toISOString(),
    lastRunAt: null,
    lastRunStatus: null,
    lastRunMessage: null,
    lastDurationMs: null,
    lastTrigger: null,
    lastRunSummary: null,
  };
}

function normalizeLastRunSummary(
  value: unknown
): ExecutiveRunLastSummary | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const result =
    v.result === "success" || v.result === "partial" || v.result === "failed"
      ? v.result
      : null;
  const trigger =
    v.trigger === "scheduler" || v.trigger === "manual" ? v.trigger : null;
  if (!result || !trigger || typeof v.ranAt !== "string") return null;
  const countsRaw =
    v.counts && typeof v.counts === "object"
      ? (v.counts as Record<string, unknown>)
      : null;
  const postedRefreshRaw =
    v.postedRefresh && typeof v.postedRefresh === "object"
      ? (v.postedRefresh as Record<string, unknown>)
      : null;
  return {
    result,
    ranAt: v.ranAt,
    trigger,
    sourceFilename:
      typeof v.sourceFilename === "string" ? v.sourceFilename : null,
    sender: typeof v.sender === "string" ? v.sender : null,
    subject: typeof v.subject === "string" ? v.subject : null,
    driveFileId: typeof v.driveFileId === "string" ? v.driveFileId : null,
    messageId: typeof v.messageId === "string" ? v.messageId : null,
    demandSheetDate:
      typeof v.demandSheetDate === "string" ? v.demandSheetDate : null,
    demandSheetDateLabel:
      typeof v.demandSheetDateLabel === "string"
        ? v.demandSheetDateLabel
        : "No new demand sheet on last run",
    failureReason:
      typeof v.failureReason === "string" ? v.failureReason : null,
    noNewSource: Boolean(v.noNewSource),
    counts: countsRaw
      ? {
          rowsImported: Number(countsRaw.rowsImported) || 0,
          newCount: Number(countsRaw.newCount) || 0,
          activeCount: Number(countsRaw.activeCount) || 0,
          reopenCount: Number(countsRaw.reopenCount) || 0,
          closedCount: Number(countsRaw.closedCount) || 0,
        }
      : null,
    postedRefresh: postedRefreshRaw
      ? {
          ok: Boolean(postedRefreshRaw.ok),
          message:
            typeof postedRefreshRaw.message === "string"
              ? postedRefreshRaw.message
              : "",
          postedYes:
            typeof postedRefreshRaw.postedYes === "number"
              ? postedRefreshRaw.postedYes
              : null,
          postedDash:
            typeof postedRefreshRaw.postedDash === "number"
              ? postedRefreshRaw.postedDash
              : null,
        }
      : null,
  };
}

export function normalizeExecutiveSchedulerConfig(
  parsed: Partial<ExecutiveSchedulerConfig>
): ExecutiveSchedulerConfig {
  const base = emptyExecutiveSchedulerConfig();
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
    lastRunStatus:
      parsed.lastRunStatus === "success" ||
      parsed.lastRunStatus === "partial" ||
      parsed.lastRunStatus === "failed"
        ? parsed.lastRunStatus
        : null,
    lastRunMessage:
      typeof parsed.lastRunMessage === "string" ? parsed.lastRunMessage : null,
    lastDurationMs:
      typeof parsed.lastDurationMs === "number" ? parsed.lastDurationMs : null,
    lastTrigger:
      parsed.lastTrigger === "scheduler" || parsed.lastTrigger === "manual"
        ? parsed.lastTrigger
        : null,
    lastRunSummary: normalizeLastRunSummary(parsed.lastRunSummary),
  };
}

/**
 * Read Executive scheduler config.
 * Postgres mode → `executive_scheduler_state` (own table, own row).
 * File mode → `.data/executive-scheduler.json` (own file).
 * Never touches `lateral_scheduler_state` / `lateral-scheduler.json`.
 */
export async function readExecutiveSchedulerConfig(): Promise<ExecutiveSchedulerConfig> {
  if (isPostgresMode()) return getSchedulerStateStore().readExecutive();
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<ExecutiveSchedulerConfig>;
    return normalizeExecutiveSchedulerConfig(parsed);
  } catch {
    return emptyExecutiveSchedulerConfig();
  }
}

export async function writeExecutiveSchedulerConfig(
  partial: Partial<ExecutiveSchedulerConfig>
): Promise<ExecutiveSchedulerConfig> {
  if (isPostgresMode()) return getSchedulerStateStore().writeExecutive(partial);
  const prior = await readExecutiveSchedulerConfig();
  const next = normalizeExecutiveSchedulerConfig({
    ...prior,
    ...partial,
    updatedAt: new Date().toISOString(),
  });
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}
