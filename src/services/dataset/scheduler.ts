import cron, { type ScheduledTask } from "node-cron";
import fs from "node:fs/promises";
import path from "node:path";
import { runAutomatedDatasetSync } from "@/services/dataset/run-automated-sync";
import { pushAppNotification } from "@/services/dataset/notifications-store";
import {
  listAutomationSchedules,
  updateScheduleRunResult,
  upsertAutomationSchedule,
  deleteAutomationSchedule,
  validateScheduleInput,
  getAutomationSchedule,
} from "@/services/dataset/schedules-store";
import { readDatasetSetup } from "@/services/dataset/secure-store";
import { isDatasetSchedulerAutoEnabled } from "@/lib/config/scheduler-policy";
import type {
  DatasetAutomationSchedule,
  DatasetAutomationScheduleView,
  MultiSchedulerStatus,
  ScheduleFrequency,
} from "@/types/dataset-schedule";
import {
  formatDatasetsLabel,
  formatScheduleTimeLabel,
} from "@/types/dataset-schedule";
import type { DatasetSyncName } from "@/types/dataset-sync";

const GLOBAL_STATE_PATH = path.join(
  process.cwd(),
  ".data",
  "dataset-scheduler-state.json"
);

const ENV_DEFAULT_TZ =
  process.env.ARA_DATASET_TZ?.trim() ||
  process.env.TZ?.trim() ||
  "Asia/Kolkata";

interface GlobalSchedulerState {
  globalPaused: boolean;
  lastError: string | null;
  /** Operator-configured timezone (from Lateral Dataset Setup). */
  timezone?: string | null;
}

const tasks = new Map<string, ScheduledTask>();
let startedAt: string | null = null;
let running = false;
let runningScheduleId: string | null = null;
let bootstrapped = false;
let globalPaused = false;
let lastError: string | null = null;
let configuredTimezone: string | null = null;

function getSchedulerTimezone() {
  return configuredTimezone?.trim() || ENV_DEFAULT_TZ;
}

async function loadGlobalState() {
  try {
    const raw = await fs.readFile(GLOBAL_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as GlobalSchedulerState & {
      paused?: boolean;
    };
    globalPaused = Boolean(parsed.globalPaused ?? parsed.paused);
    lastError = parsed.lastError ?? null;
    configuredTimezone =
      typeof parsed.timezone === "string" && parsed.timezone.trim()
        ? parsed.timezone.trim()
        : null;
  } catch {
    // first boot
  }
}

async function persistGlobalState() {
  await fs.mkdir(path.dirname(GLOBAL_STATE_PATH), { recursive: true });
  const payload: GlobalSchedulerState = {
    globalPaused,
    lastError,
    timezone: configuredTimezone,
  };
  await fs.writeFile(
    GLOBAL_STATE_PATH,
    JSON.stringify(payload, null, 2),
    "utf8"
  );
}

/** Persist timezone chosen in Lateral Dataset Setup (used by node-cron). */
export async function setDatasetSchedulerTimezone(timezone: string) {
  const next = timezone.trim();
  if (!next) throw new Error("Timezone is required.");
  // Validate IANA-ish timezone via Intl
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: next }).format(new Date());
  } catch {
    throw new Error(`Invalid timezone: ${next}`);
  }
  configuredTimezone = next;
  await persistGlobalState();
  await reloadDatasetScheduler();
  return getSchedulerTimezone();
}

export function getDatasetSchedulerTimezone() {
  return getSchedulerTimezone();
}

function parseSyncTime(syncTime: string): { minute: number; hour: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(syncTime.trim());
  if (!match) return { hour: 7, minute: 0 };
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return { hour, minute };
}

export function buildCronExpressionsFromSchedule(
  schedule: Pick<
    DatasetAutomationSchedule,
    | "frequency"
    | "syncTime"
    | "dayOfWeek"
    | "customDays"
    | "customTimes"
    | "customCron"
  >
): string[] {
  if (schedule.frequency === "hourly") {
    return ["0 * * * *"];
  }

  if (schedule.frequency === "custom") {
    const days = [...(schedule.customDays ?? [])]
      .filter((day) => day >= 0 && day <= 6)
      .sort((a, b) => a - b);
    const times = [...(schedule.customTimes ?? [])].filter(Boolean);
    if (days.length === 0) {
      throw new Error("Custom schedule needs at least one day selected.");
    }
    if (times.length === 0) {
      throw new Error("Custom schedule needs at least one time.");
    }
    const dow = days.join(",");
    const expressions = times.map((time) => {
      const { hour, minute } = parseSyncTime(time);
      return `${minute} ${hour} * * ${dow}`;
    });
    for (const expression of expressions) {
      if (!cron.validate(expression)) {
        throw new Error(`Invalid custom schedule expression: ${expression}`);
      }
    }
    return expressions;
  }

  // Legacy custom_cron stored on old records (should already be migrated)
  if ((schedule as { frequency?: string }).frequency === "custom_cron") {
    const expression = (schedule.customCron ?? "").trim();
    if (!cron.validate(expression)) {
      throw new Error(`Invalid custom cron expression: ${expression}`);
    }
    return [expression];
  }

  const { hour, minute } = parseSyncTime(schedule.syncTime || "07:00");

  if (schedule.frequency === "weekdays") {
    return [`${minute} ${hour} * * 1-5`];
  }

  if (schedule.frequency === "weekly") {
    const dow = Math.min(6, Math.max(0, schedule.dayOfWeek ?? 1));
    return [`${minute} ${hour} * * ${dow}`];
  }

  return [`${minute} ${hour} * * *`];
}

/** @deprecated Prefer buildCronExpressionsFromSchedule */
export function buildCronFromSchedule(
  schedule: Pick<
    DatasetAutomationSchedule,
    | "frequency"
    | "syncTime"
    | "dayOfWeek"
    | "customDays"
    | "customTimes"
    | "customCron"
  >
): string {
  return buildCronExpressionsFromSchedule(schedule)[0];
}

/** @deprecated Prefer buildCronFromSchedule */
export function buildCronFromSetup(setup: {
  syncFrequency?: string;
  syncTime?: string;
  customCron?: string;
  customDays?: number[];
  customTimes?: string[];
}): string {
  const frequency =
    setup.syncFrequency === "custom_cron"
      ? "custom"
      : ((setup.syncFrequency as ScheduleFrequency) || "daily");
  return buildCronFromSchedule({
    frequency,
    syncTime: setup.syncTime || "07:00",
    dayOfWeek: 1,
    customDays: setup.customDays ?? [1, 2, 3, 4, 5],
    customTimes: setup.customTimes ?? [setup.syncTime || "07:00"],
    customCron: setup.customCron,
  });
}

export function estimateNextRun(
  cronExpression: string,
  timezone: string
): string | null {
  try {
    const parts = cronExpression.split(/\s+/);
    if (parts.length < 5) return null;

    const [minPart, hourPart, , , dowPart] = parts;
    const now = new Date(
      new Date().toLocaleString("en-US", { timeZone: timezone })
    );

    if (minPart === "0" && hourPart === "*" && (!dowPart || dowPart === "*")) {
      const next = new Date(now);
      next.setMinutes(0, 0, 0);
      next.setHours(next.getHours() + 1);
      return next.toISOString();
    }

    const minute = Number(minPart);
    const hour = Number(hourPart);
    if (!Number.isFinite(minute) || !Number.isFinite(hour)) return null;

    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    candidate.setHours(hour, minute, 0, 0);

    const weekdaysOnly = dowPart === "1-5";
    const singleDow =
      dowPart && /^\d$/.test(dowPart) ? Number(dowPart) : null;
    const multiDow =
      dowPart && /^\d(,\d)+$/.test(dowPart)
        ? dowPart.split(",").map(Number)
        : null;

    const advance = () => {
      candidate.setDate(candidate.getDate() + 1);
      if (weekdaysOnly) {
        while (candidate.getDay() === 0 || candidate.getDay() === 6) {
          candidate.setDate(candidate.getDate() + 1);
        }
      }
      if (singleDow != null) {
        while (candidate.getDay() !== singleDow) {
          candidate.setDate(candidate.getDate() + 1);
        }
      }
      if (multiDow) {
        while (!multiDow.includes(candidate.getDay())) {
          candidate.setDate(candidate.getDate() + 1);
        }
      }
    };

    if (candidate.getTime() <= now.getTime()) {
      advance();
    } else if (weekdaysOnly && (candidate.getDay() === 0 || candidate.getDay() === 6)) {
      advance();
    } else if (singleDow != null && candidate.getDay() !== singleDow) {
      advance();
    } else if (multiDow && !multiDow.includes(candidate.getDay())) {
      advance();
    }

    return candidate.toISOString();
  } catch {
    return null;
  }
}

export function estimateNextRunFromExpressions(
  expressions: string[],
  timezone: string
): string | null {
  const nexts = expressions
    .map((expression) => estimateNextRun(expression, timezone))
    .filter((value): value is string => Boolean(value))
    .sort();
  return nexts[0] ?? null;
}

function stopAllTasks() {
  for (const task of tasks.values()) {
    task.stop();
  }
  tasks.clear();
}

async function executeScheduleRun(scheduleId: string) {
  if (globalPaused) {
    console.info(
      `[dataset-scheduler] Global pause — skipping schedule ${scheduleId}`
    );
    return;
  }

  const schedule = await getAutomationSchedule(scheduleId);
  if (!schedule || !schedule.enabled || schedule.paused) {
    console.info(
      `[dataset-scheduler] Schedule ${scheduleId} inactive — skipping`
    );
    return;
  }

  if (running) {
    console.warn(
      `[dataset-scheduler] Skipping overlapping run for ${schedule.name}`
    );
    return;
  }

  running = true;
  runningScheduleId = scheduleId;
  const startedMs = Date.now();

  try {
    console.info(
      `[dataset-scheduler] Starting "${schedule.name}" for ${schedule.datasetNames.join(", ")} (executable types only)`
    );
    // Routes to Lateral job only; Executive/Consulting are never executed.
    const outcome = await runAutomatedDatasetSync("scheduler", {
      scheduleId,
      scheduleName: schedule.name,
      datasetNames: schedule.datasetNames,
    });
    const durationMs = Math.max(0, Date.now() - startedMs);
    await updateScheduleRunResult(scheduleId, {
      lastRunAt: outcome.ranAt,
      lastRunStatus: outcome.status,
      lastRunMessage: outcome.message,
      lastDurationMs: durationMs,
    });
    lastError = null;
    await persistGlobalState();
    console.info(`[dataset-scheduler] ${schedule.name}: ${outcome.message}`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Scheduled dataset sync failed.";
    const durationMs = Math.max(0, Date.now() - startedMs);
    await updateScheduleRunResult(scheduleId, {
      lastRunAt: new Date().toISOString(),
      lastRunStatus: "failed",
      lastRunMessage: message,
      lastDurationMs: durationMs,
    });
    lastError = message;
    await persistGlobalState();
    await pushAppNotification({
      kind: "dataset_sync_failed",
      title: `Schedule failed: ${schedule.name}`,
      body: message,
      href: "/dataset",
      meta: { trigger: "scheduler", scheduleId },
    });
    const { sendFailureEmailAlert } = await import(
      "@/services/dataset/failure-email"
    );
    await sendFailureEmailAlert({
      subject: `[ARA] Schedule failed: ${schedule.name}`,
      body: message,
    });
    console.error("[dataset-scheduler]", message);
  } finally {
    running = false;
    runningScheduleId = null;
  }
}

function toScheduleView(
  schedule: DatasetAutomationSchedule
): DatasetAutomationScheduleView {
  let cronExpressions: string[] = [];
  try {
    cronExpressions = buildCronExpressionsFromSchedule(schedule);
  } catch {
    cronExpressions = schedule.customCron ? [schedule.customCron] : [];
  }

  const cronExpression = cronExpressions.join(" | ") || "invalid";
  const armed =
    schedule.enabled &&
    !schedule.paused &&
    !globalPaused &&
    cronExpressions.length > 0;

  return {
    ...schedule,
    cronExpression,
    cronExpressions,
    nextRunAt: armed
      ? estimateNextRunFromExpressions(cronExpressions, getSchedulerTimezone())
      : null,
    statusLabel: !schedule.enabled
      ? "Disabled"
      : schedule.paused || globalPaused
        ? "Paused"
        : "Active",
    timeLabel: formatScheduleTimeLabel(schedule),
    datasetsLabel: formatDatasetsLabel(schedule.datasetNames),
  };
}

/**
 * (Re)load all schedules and arm enabled, non-paused cron jobs.
 *
 * SCOPE: Legacy multi-dataset cron is disarmed while only Lateral is executable.
 * Lateral runs exclusively via `startLateralScheduler` / `invokeLateralJob`.
 * Executive/Consulting schedules may remain in config but must never arm.
 */
export async function reloadDatasetScheduler(): Promise<MultiSchedulerStatus> {
  if (!isDatasetSchedulerAutoEnabled()) {
    stopAllTasks();
    return getDatasetSchedulerStatusAsync();
  }

  await loadGlobalState();
  stopAllTasks();
  startedAt = startedAt ?? new Date().toISOString();

  // Do not arm legacy multi-dataset crons. Only Lateral executes (dedicated scheduler).
  console.info(
    "[dataset-scheduler] Legacy multi-dataset cron disarmed — only Lateral executes via dedicated Lateral scheduler. Executive/Consulting jobs are not implemented."
  );
  lastError = null;
  await persistGlobalState();
  return getDatasetSchedulerStatusAsync();
}

export async function startDatasetScheduler(): Promise<void> {
  if (!isDatasetSchedulerAutoEnabled()) {
    console.info(
      "[dataset-scheduler] Automatic cron disabled. Legacy multi-dataset jobs remain disarmed."
    );
    bootstrapped = true;
    return;
  }

  await reloadDatasetScheduler();
  bootstrapped = true;
  const status = getDatasetSchedulerStatus();
  console.info(
    `[dataset-scheduler] Ready — ${status.activeCount}/${status.scheduleCount} schedule(s) active`
  );
}

export async function ensureDatasetSchedulerStarted(): Promise<MultiSchedulerStatus> {
  if (!bootstrapped) {
    await startDatasetScheduler();
  }
  return getDatasetSchedulerStatusAsync();
}

/** Prefer getDatasetSchedulerStatusAsync for full schedule list */
export function getDatasetSchedulerStatus(): MultiSchedulerStatus {
  return getDatasetSchedulerStatusSync([]);
}

function getDatasetSchedulerStatusSync(
  schedules: DatasetAutomationSchedule[]
): MultiSchedulerStatus {
  const envDisabled = !isDatasetSchedulerAutoEnabled();
  const views = schedules.map(toScheduleView);
  const activeCount = views.filter((item) => item.statusLabel === "Active").length;
  const nextCandidates = views
    .map((item) => item.nextRunAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  const lastRuns = views
    .filter((item) => item.lastRunAt)
    .sort((a, b) =>
      String(b.lastRunAt).localeCompare(String(a.lastRunAt))
    );
  const latest = lastRuns[0];

  return {
    enabled: !envDisabled && activeCount > 0,
    paused: globalPaused || (schedules.length > 0 && activeCount === 0),
    globalPaused,
    running,
    runningScheduleId,
    timezone: getSchedulerTimezone(),
    scheduleCount: schedules.length,
    activeCount,
    startedAt,
    schedules: views,
    cronExpression: views.find((item) => item.statusLabel === "Active")
      ?.cronExpression ?? null,
    syncFrequency:
      views.find((item) => item.statusLabel === "Active")?.frequency ?? null,
    syncTime: views.find((item) => item.statusLabel === "Active")?.syncTime ?? null,
    nextRunAt: nextCandidates[0] ?? null,
    lastRunAt: latest?.lastRunAt ?? null,
    lastRunStatus: latest?.lastRunStatus ?? null,
    lastRunMessage: latest?.lastRunMessage ?? null,
    lastError,
  };
}

export async function getDatasetSchedulerStatusAsync(): Promise<MultiSchedulerStatus> {
  await loadGlobalState();
  const schedules = await listAutomationSchedules();
  return getDatasetSchedulerStatusSync(schedules);
}

export async function pauseDatasetScheduler() {
  await loadGlobalState();
  globalPaused = true;
  stopAllTasks();
  await persistGlobalState();
  await pushAppNotification({
    kind: "dataset_scheduler",
    title: "All schedules paused",
    body: "Automatic sync is paused globally. Manual sync remains available.",
    href: "/dataset",
  });
  return getDatasetSchedulerStatusAsync();
}

export async function resumeDatasetScheduler() {
  await loadGlobalState();
  globalPaused = false;
  await persistGlobalState();
  await reloadDatasetScheduler();
  await pushAppNotification({
    kind: "dataset_scheduler",
    title: "Schedules resumed",
    body: "Automatic sync is active again for enabled schedules.",
    href: "/dataset",
  });
  return getDatasetSchedulerStatusAsync();
}

export async function triggerDatasetSyncNow(options?: {
  scheduleId?: string;
  datasetNames?: DatasetSyncName[];
}) {
  if (running) {
    throw new Error("A dataset sync is already running.");
  }

  let datasetNames = options?.datasetNames;
  let scheduleId = options?.scheduleId;
  let scheduleName: string | undefined;

  if (scheduleId) {
    const schedule = await getAutomationSchedule(scheduleId);
    if (!schedule) throw new Error("Schedule not found.");
    datasetNames = schedule.datasetNames;
    scheduleName = schedule.name;
  }

  running = true;
  runningScheduleId = scheduleId ?? null;
  const startedMs = Date.now();

  try {
    const outcome = await runAutomatedDatasetSync("manual", {
      scheduleId,
      scheduleName,
      datasetNames,
    });
    if (scheduleId) {
      await updateScheduleRunResult(scheduleId, {
        lastRunAt: outcome.ranAt,
        lastRunStatus: outcome.status,
        lastRunMessage: outcome.message,
        lastDurationMs: Math.max(0, Date.now() - startedMs),
      });
    }
    return outcome;
  } finally {
    running = false;
    runningScheduleId = null;
  }
}

export async function createOrUpdateSchedule(body: unknown) {
  const validated = validateScheduleInput(body);
  if (!validated.ok) throw new Error(validated.error);
  const saved = await upsertAutomationSchedule(validated.data);
  await reloadDatasetScheduler();
  return saved;
}

export async function removeSchedule(id: string) {
  await deleteAutomationSchedule(id);
  await reloadDatasetScheduler();
}

export async function setSchedulePaused(id: string, paused: boolean) {
  const schedule = await getAutomationSchedule(id);
  if (!schedule) throw new Error("Schedule not found.");
  await upsertAutomationSchedule({ ...schedule, paused });
  await reloadDatasetScheduler();
  return getAutomationSchedule(id);
}

export async function setScheduleEnabled(id: string, enabled: boolean) {
  const schedule = await getAutomationSchedule(id);
  if (!schedule) throw new Error("Schedule not found.");
  await upsertAutomationSchedule({
    ...schedule,
    enabled,
    paused: enabled ? schedule.paused : schedule.paused,
  });
  await reloadDatasetScheduler();
  return getAutomationSchedule(id);
}

// Re-export for API convenience
export type { MultiSchedulerStatus };
