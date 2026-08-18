import cron, { type ScheduledTask } from "node-cron";
import fs from "node:fs/promises";
import path from "node:path";
import { isPostgresMode } from "@/lib/persistence/persistence-mode";
import { getSchedulerStateStore } from "@/lib/persistence/store-factory";
import { acquireLateralJobLock } from "@/lib/persistence/job-lock";
import {
  buildCronExpressionsFromSchedule,
  estimateNextRunFromExpressions,
} from "@/services/dataset/scheduler";
import { executeLateralDatasetJob } from "@/services/lateral-processing/lateral-job";
import { readLateralGmailCheckpoint } from "@/services/lateral-processing/lateral-gmail-checkpoint-store";
import { appendLateralSyncHistory } from "@/services/lateral-processing/lateral-sync-history-store";
import type { LateralGmailCheckpoint } from "@/types/lateral-gmail-checkpoint";
import { readLateralDataProcessingSetup } from "@/services/lateral-processing/setup-store";
import type {
  LateralProcessingStatusView,
  LateralSchedulerConfig,
  LateralSchedulerStatus,
} from "@/types/lateral-scheduler";
import { DEFAULT_LATERAL_TIMEZONE } from "@/types/lateral-processing-setup";
import { getSharedGoogleConnectionStatus } from "@/services/dataset/google-connection";
import { getLateralRunProgress } from "@/services/lateral-processing/lateral-run-progress";
import type { ScheduleFrequency } from "@/types/dataset-schedule";
import {
  DEFAULT_CUSTOM_DAYS,
  DEFAULT_CUSTOM_TIMES,
  formatScheduleTimeLabel,
  normalizeCustomDays,
  normalizeCustomTimes,
  normalizeHhMm,
  SCHEDULE_FREQUENCY_LABELS,
} from "@/types/dataset-schedule";
import {
  datasetSchedulerPolicyReason,
  isDatasetSchedulerAutoEnabled,
  shouldSkipScheduledTickAfterArm,
} from "@/lib/config/scheduler-policy";
import { DATASET_LOG_DIR } from "@/services/dataset/paths";

const STORE_PATH = path.join(
  process.cwd(),
  ".data",
  "lateral-scheduler.json"
);

const tasks = new Map<string, ScheduledTask>();
let running = false;
let bootstrapped = false;
let cronArmedAtMs = 0;

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
  };
}

export async function readLateralSchedulerConfig(): Promise<LateralSchedulerConfig> {
  if (isPostgresMode()) return getSchedulerStateStore().readLateral();
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<LateralSchedulerConfig>;
    return normalizeConfig(parsed);
  } catch {
    return emptyConfig();
  }
}

export async function writeLateralSchedulerConfig(
  partial: Partial<LateralSchedulerConfig>
): Promise<LateralSchedulerConfig> {
  if (isPostgresMode()) return getSchedulerStateStore().writeLateral(partial);
  const prior = await readLateralSchedulerConfig();
  const next = normalizeConfig({
    ...prior,
    ...partial,
    updatedAt: new Date().toISOString(),
  });
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function expressionsForConfig(config: LateralSchedulerConfig): string[] {
  return buildCronExpressionsFromSchedule({
    frequency: config.frequency,
    syncTime: config.syncTime,
    dayOfWeek: config.dayOfWeek,
    customDays: config.customDays,
    customTimes: config.customTimes,
  });
}

function stopLateralTasks() {
  for (const task of tasks.values()) {
    task.stop();
  }
  tasks.clear();
}

export function stopLateralScheduler(): void {
  stopLateralTasks();
}

function appendSchedulerLog(event: string, detail?: Record<string, unknown>) {
  const entry = { at: new Date().toISOString(), event, ...detail };
  // Always emit structured log to stdout (captured by Vercel log drain).
  console.info("[lateral-scheduler]", JSON.stringify(entry));
  // In file mode also write to disk for local audit trail.
  if (!isPostgresMode()) {
    const day = entry.at.slice(0, 10);
    const line = JSON.stringify(entry) + "\n";
    void fs
      .mkdir(DATASET_LOG_DIR, { recursive: true })
      .then(() =>
        fs.appendFile(
          path.join(DATASET_LOG_DIR, `lateral-scheduler-${day}.jsonl`),
          line,
          "utf8"
        )
      )
      .catch(() => undefined);
  }
}

export async function getLateralSchedulerStatus(): Promise<
  LateralSchedulerStatus & { gmailCheckpoint: LateralGmailCheckpoint }
> {
  const config = await readLateralSchedulerConfig();
  let cronExpressions: string[] = [];
  try {
    cronExpressions = expressionsForConfig(config);
  } catch {
    cronExpressions = [];
  }
  const cronExpression = cronExpressions.join(" | ") || "invalid";
  const armed =
    isDatasetSchedulerAutoEnabled() &&
    config.enabled &&
    !config.paused &&
    cronExpressions.length > 0;
  const gmailCheckpoint = await readLateralGmailCheckpoint();
  return {
    ...config,
    datasetName: "Lateral",
    statusLabel: !config.enabled
      ? "Disabled"
      : config.paused
        ? "Paused"
        : "Active",
    nextRunAt: armed
      ? estimateNextRunFromExpressions(cronExpressions, config.timezone)
      : null,
    running,
    cronExpression,
    cronExpressions,
    timeLabel: formatScheduleTimeLabel(config),
    gmailCheckpoint,
  };
}

async function armLateralCron(): Promise<LateralSchedulerStatus> {
  stopLateralTasks();

  if (!isDatasetSchedulerAutoEnabled()) {
    console.info(
      `[lateral-scheduler] Automatic cron not armed (${datasetSchedulerPolicyReason()}). Manual Run All is unchanged.`
    );
    appendSchedulerLog("cron_not_armed", {
      reason: datasetSchedulerPolicyReason(),
    });
    return getLateralSchedulerStatus();
  }

  const config = await readLateralSchedulerConfig();
  if (!config.enabled || config.paused) {
    return getLateralSchedulerStatus();
  }

  let expressions: string[];
  try {
    expressions = expressionsForConfig(config);
  } catch (error) {
    console.error(
      "[lateral-scheduler] Invalid schedule — not armed:",
      error instanceof Error ? error.message : error
    );
    return getLateralSchedulerStatus();
  }

  cronArmedAtMs = Date.now();
  const timezone = config.timezone;

  expressions.forEach((expression, index) => {
    const task = cron.schedule(
      expression,
      () => {
        void runLateralScheduledTick(timezone);
      },
      {
        timezone,
        noOverlap: true,
        name: `lateral-scheduler-${index}`,
        missedExecutionTolerance: 0,
      }
    );
    tasks.set(`lateral::${index}`, task);
  });

  console.info(
    `[lateral-scheduler] Armed ${config.frequency} times=${config.frequency === "custom" ? config.customTimes.join(",") : config.syncTime} TZ=${timezone} cron=[${expressions.join(" | ")}] (startup will not replay the current minute)`
  );
  appendSchedulerLog("cron_armed", {
    timezone,
    expressions,
  });
  return getLateralSchedulerStatus();
}

async function runLateralScheduledTick(timezone: string) {
  if (
    shouldSkipScheduledTickAfterArm({
      armedAtMs: cronArmedAtMs,
      nowMs: Date.now(),
      timezone,
    })
  ) {
    console.info(
      "[lateral-scheduler] Skipping scheduled tick in the same minute as process arm (no missed-run catch-up)."
    );
    appendSchedulerLog("startup_minute_skipped", { timezone });
    return;
  }
  const config = await readLateralSchedulerConfig();
  if (!config.enabled || config.paused) return;
  if (!isDatasetSchedulerAutoEnabled()) return;
  if (running) {
    console.warn("[lateral-scheduler] Skipping overlapping run");
    appendSchedulerLog("overlap_skipped");
    return;
  }
  await invokeLateralJob("scheduler");
}

/**
 * Shared entry for cron + Run Now.
 *
 * For postgres mode: acquires a PostgreSQL pg_advisory_lock before
 * starting the job. If another worker already holds the lock, throws
 * with a "already running" message — identical to the in-memory `running`
 * guard used in file mode.
 */
export async function invokeLateralJob(
  trigger: "scheduler" | "manual"
): Promise<{
  status: LateralSchedulerStatus;
  outcome: Awaited<ReturnType<typeof executeLateralDatasetJob>>;
}> {
  if (running) {
    throw new Error("Lateral Dataset Sync is already running.");
  }

  const lock = await acquireLateralJobLock();
  if (!lock.acquired) {
    throw new Error(lock.message);
  }

  running = true;
  try {
    console.info(`[lateral-scheduler] Starting Lateral job (${trigger})`);
    const outcome = await executeLateralDatasetJob(trigger);
    await writeLateralSchedulerConfig({
      lastRunAt: outcome.ranAt,
      lastRunStatus: outcome.status,
      lastRunMessage: outcome.message,
      lastDurationMs: outcome.durationMs,
      lastTrigger: trigger,
    });

    // Persist UI sync history (never stores OAuth tokens)
    const summary = outcome.syncSummary;
    const checkpoint = await readLateralGmailCheckpoint();
    await appendLateralSyncHistory({
      syncTime: outcome.ranAt,
      sourceEmail:
        summary?.sourceEmail ||
        checkpoint.messageId ||
        "—",
      originalFilename:
        summary?.originalFilename ||
        checkpoint.attachmentFilename ||
        "—",
      googleDriveFileId:
        summary?.googleDriveFileId ||
        checkpoint.driveFileId ||
        "—",
      rowsImported: summary?.rowsImported ?? 0,
      newCount: summary?.newCount ?? 0,
      activeCount: summary?.activeCount ?? 0,
      reopenCount: summary?.reopenCount ?? 0,
      closedCount: summary?.closedCount ?? 0,
      result: outcome.status === "success" ? "Success" : "Failed",
      error:
        outcome.status === "success"
          ? null
          : outcome.failure?.message || outcome.message,
      trigger,
      durationMs: outcome.durationMs,
    }).catch((err) => {
      console.warn("[lateral-scheduler] Failed to append sync history", err);
    });

    console.info(`[lateral-scheduler] ${outcome.message}`);
    return {
      status: await getLateralSchedulerStatus(),
      outcome,
    };
  } finally {
    running = false;
    await lock.release();
  }
}

export async function reloadLateralScheduler(): Promise<LateralSchedulerStatus> {
  return armLateralCron();
}

export async function startLateralScheduler(): Promise<void> {
  if (!isDatasetSchedulerAutoEnabled()) {
    console.info(
      `[lateral-scheduler] Automatic cron disabled (${datasetSchedulerPolicyReason()}). Manual Run All is unchanged.`
    );
    appendSchedulerLog("auto_disabled", {
      reason: datasetSchedulerPolicyReason(),
    });
    bootstrapped = true;
    return;
  }

  // Seed schedule/timezone from Lateral Dataset Setup when store is fresh
  const setup = await readLateralDataProcessingSetup().catch(() => null);
  const current = await readLateralSchedulerConfig();
  if (setup && current.lastRunAt == null) {
    await writeLateralSchedulerConfig({
      frequency: setup.schedule?.frequency || current.frequency,
      syncTime: setup.schedule?.syncTime || current.syncTime,
      dayOfWeek: setup.schedule?.dayOfWeek ?? current.dayOfWeek,
      customDays: setup.schedule?.customDays ?? current.customDays,
      customTimes: setup.schedule?.customTimes ?? current.customTimes,
      timezone: setup.timezone || current.timezone,
      enabled: setup.schedule?.enabled !== false,
    });
  }

  await armLateralCron();
  bootstrapped = true;
}

export async function ensureLateralSchedulerStarted(): Promise<LateralSchedulerStatus> {
  if (!bootstrapped) {
    await startLateralScheduler();
  }
  return getLateralSchedulerStatus();
}

export async function pauseLateralScheduler(): Promise<LateralSchedulerStatus> {
  await writeLateralSchedulerConfig({ paused: true });
  return armLateralCron();
}

export async function resumeLateralScheduler(): Promise<LateralSchedulerStatus> {
  await writeLateralSchedulerConfig({ paused: false, enabled: true });
  return armLateralCron();
}

export async function updateLateralScheduler(input: {
  frequency?: ScheduleFrequency;
  syncTime?: string;
  dayOfWeek?: number;
  customDays?: number[];
  customTimes?: string[];
  timezone?: string;
  enabled?: boolean;
  paused?: boolean;
}): Promise<LateralSchedulerStatus> {
  await writeLateralSchedulerConfig({
    frequency: input.frequency,
    syncTime: input.syncTime,
    dayOfWeek: input.dayOfWeek,
    customDays: input.customDays,
    customTimes: input.customTimes,
    timezone: input.timezone,
    enabled: input.enabled,
    paused: input.paused,
  });
  return armLateralCron();
}

/**
 * Safe Lateral processing status for Dataset UI (no OAuth tokens / secrets).
 */
export async function getLateralProcessingStatusView(): Promise<LateralProcessingStatusView> {
  const { listLateralSyncHistory } = await import(
    "@/services/lateral-processing/lateral-sync-history-store"
  );
  const [scheduler, connections, checkpoint, history] = await Promise.all([
    getLateralSchedulerStatus(),
    getSharedGoogleConnectionStatus({ probeDrive: false }),
    readLateralGmailCheckpoint(),
    listLateralSyncHistory(1),
  ]);

  const lastResult: LateralProcessingStatusView["lastResult"] =
    scheduler.lastRunStatus === "success"
      ? "Success"
      : scheduler.lastRunStatus === "partial"
        ? "Partial"
        : scheduler.lastRunStatus === "failed"
          ? "Failed"
          : null;

  const latestHistory = history[0];
  const lastProcessedEmail =
    (latestHistory?.sourceEmail && latestHistory.sourceEmail !== "—"
      ? latestHistory.sourceEmail
      : null) ||
    (checkpoint.messageId
      ? [
          `Message ${checkpoint.messageId}`,
          checkpoint.receivedAt
            ? new Date(checkpoint.receivedAt).toLocaleString("en-IN")
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null);

  return {
    datasetName: "Lateral",
    gmail: {
      connected: Boolean(connections.gmail?.connected),
      email: connections.email ?? null,
    },
    drive: {
      connected: Boolean(connections.drive?.connected),
    },
    schedule: {
      frequency: SCHEDULE_FREQUENCY_LABELS[scheduler.frequency] || scheduler.frequency,
      syncTime: scheduler.syncTime,
      timeLabel: scheduler.timeLabel,
      timezone: scheduler.timezone,
    },
    status:
      scheduler.statusLabel === "Disabled"
        ? "Disabled"
        : scheduler.statusLabel === "Paused"
          ? "Paused"
          : "Active",
    lastSuccessfulSync:
      checkpoint.processedAt ||
      (scheduler.lastRunStatus === "success" ? scheduler.lastRunAt : null),
    lastProcessedFile:
      checkpoint.attachmentFilename ||
      (latestHistory?.originalFilename !== "—"
        ? latestHistory?.originalFilename ?? null
        : null),
    lastProcessedEmail,
    lastResult,
    nextScheduledRun: scheduler.nextRunAt,
    running: scheduler.running,
    lastRunMessage: scheduler.lastRunMessage,
    runProgress: (() => {
      const progress = getLateralRunProgress();
      return progress.stages.length > 0 ? progress : null;
    })(),
  };
}
