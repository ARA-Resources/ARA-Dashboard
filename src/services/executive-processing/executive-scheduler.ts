/**
 * Phase E5 — Executive node-cron arming, layered on top of Phase E1's
 * `executive-scheduler-state.ts` (pure config persistence, no cron).
 * Mirrors `lateral-scheduler.ts`'s cron-arming half structurally.
 *
 * Safe-by-default (explicit user requirement, 2026-09-11):
 * - `ARA_EXECUTIVE_SCHEDULER` is a SEPARATE env var from Lateral's
 *   `ARA_DATASET_SCHEDULER` (already "on" in production for Lateral) and
 *   defaults OFF unconditionally — see `isExecutiveDatasetSchedulerAutoEnabled()`
 *   in `scheduler-policy.ts`.
 * - `executive_scheduler_state.enabled` defaults FALSE (migration 010),
 *   unlike Lateral's `lateral_scheduler_state.enabled` which defaults TRUE.
 * Both gates must be explicitly turned on before any cron task is armed.
 *
 * Process ownership (`ARA_SCHEDULER_OWNER` / `ARA_WORKER_PROCESS`) is reused
 * directly from `scheduler-owner.ts` — that decision ("is this the Next
 * process or the Worker process") is pure deployment topology, identical
 * for every pipeline in this app; it carries no Lateral business logic and
 * no shared mutable state.
 *
 * The job body itself (`invokeExecutiveJob`, Phase E4) already acquires and
 * releases `acquireExecutiveJobLock()` internally, so — unlike
 * `lateral-scheduler.ts`, which wraps a lock-free job function in its own
 * `invokeLateralJob` — this module does not need a second lock wrapper or
 * an in-memory `running` guard; the Postgres advisory lock alone already
 * covers same-process and cross-process overlap correctly (proven in E4).
 */
import cron, { type ScheduledTask } from "node-cron";
import {
  buildCronExpressionsFromSchedule,
  estimateNextRunFromExpressions,
} from "@/services/dataset/scheduler";
import {
  executiveDatasetSchedulerPolicyReason,
  isExecutiveDatasetSchedulerAutoEnabled,
  shouldSkipScheduledTickAfterArm,
} from "@/lib/config/scheduler-policy";
import {
  schedulerOwnershipReason,
  shouldThisProcessOwnLateralCron,
} from "@/lib/config/scheduler-owner";
import {
  readExecutiveSchedulerConfig,
  writeExecutiveSchedulerConfig,
} from "@/services/executive-processing/executive-scheduler-state";
import { readExecutiveGmailCheckpoint } from "@/services/executive-processing/executive-gmail-checkpoint-store";
import {
  invokeExecutiveJob,
  type InvokeExecutiveJobDeps,
} from "@/services/executive-processing/executive-job";
import { appendExecutiveSyncHistory } from "@/services/executive-processing/executive-sync-history-store";
import type {
  ExecutiveJobOutcome,
  ExecutiveSchedulerConfig,
  ExecutiveSchedulerStatus,
} from "@/types/executive-scheduler";
import {
  formatScheduleTimeLabel,
  normalizeCustomDays,
  normalizeCustomTimes,
  normalizeHhMm,
  SCHEDULE_FREQUENCY_LABELS,
} from "@/types/dataset-schedule";
import type { ScheduleFrequency } from "@/types/dataset-schedule";
import { getSharedGoogleConnectionStatus } from "@/services/dataset/google-connection";
import { listExecutiveSyncHistory } from "@/services/executive-processing/executive-sync-history-store";
import type { ExecutiveProcessingStatusView } from "@/types/executive-scheduler";

/**
 * Runtime state lives on `globalThis` for the same reason as
 * `lateral-scheduler.ts`: the instrumentation bundle and each API-route
 * bundle otherwise get their own copies, so a route could arm a duplicate
 * cron set that the boot bundle's `stopExecutiveTasks()` can't see.
 */
type ExecutiveSchedulerRuntime = {
  tasks: Map<string, ScheduledTask>;
  bootstrapped: boolean;
  cronArmedAtMs: number;
  /** Jobs currently executing in this process (cron tick or Run Now). */
  runningJobs: number;
};
const runtimeGlobal = globalThis as typeof globalThis & {
  __araExecutiveScheduler?: ExecutiveSchedulerRuntime;
};
const rt = (runtimeGlobal.__araExecutiveScheduler ??= {
  tasks: new Map(),
  bootstrapped: false,
  cronArmedAtMs: 0,
  runningJobs: 0,
});

function expressionsForConfig(config: ExecutiveSchedulerConfig): string[] {
  return buildCronExpressionsFromSchedule({
    frequency: config.frequency,
    syncTime: config.syncTime,
    dayOfWeek: config.dayOfWeek,
    customDays: config.customDays,
    customTimes: config.customTimes,
  });
}

function stopExecutiveTasks() {
  for (const task of rt.tasks.values()) {
    // destroy (not stop) also removes the task from node-cron's registry.
    void task.destroy();
  }
  rt.tasks.clear();
}

export function stopExecutiveScheduler(): void {
  stopExecutiveTasks();
}

export async function getExecutiveSchedulerStatus(): Promise<ExecutiveSchedulerStatus> {
  const config = await readExecutiveSchedulerConfig();
  let cronExpressions: string[] = [];
  try {
    cronExpressions = expressionsForConfig(config);
  } catch {
    cronExpressions = [];
  }
  const cronExpression = cronExpressions.join(" | ") || "invalid";
  const armed =
    isExecutiveDatasetSchedulerAutoEnabled() &&
    config.enabled &&
    !config.paused &&
    cronExpressions.length > 0;
  const gmailCheckpoint = await readExecutiveGmailCheckpoint();
  return {
    ...config,
    datasetName: "Executive",
    statusLabel: !config.enabled
      ? "Disabled"
      : config.paused
        ? "Paused"
        : !armed
          ? "Not armed"
          : "Active",
    notArmedReason: armed
      ? null
      : !isExecutiveDatasetSchedulerAutoEnabled()
        ? executiveDatasetSchedulerPolicyReason()
        : cronExpressions.length === 0
          ? "Invalid schedule"
          : null,
    nextRunAt: armed
      ? estimateNextRunFromExpressions(cronExpressions, config.timezone)
      : null,
    // A job is executing right now — not merely "cron is armed" (that's
    // `cronArmed`). The panel shows "Running…" and disables Run Now off this.
    running: rt.runningJobs > 0,
    cronArmed: rt.tasks.size > 0 && armed,
    cronExpression,
    cronExpressions,
    timeLabel: formatScheduleTimeLabel(config),
    gmailCheckpoint: {
      messageId: gmailCheckpoint.messageId,
      receivedAt: gmailCheckpoint.receivedAt,
      attachmentFilename: gmailCheckpoint.attachmentFilename,
      driveFileId: gmailCheckpoint.driveFileId,
      processedAt: gmailCheckpoint.processedAt,
    },
  };
}

async function armExecutiveCron(): Promise<ExecutiveSchedulerStatus> {
  stopExecutiveTasks();

  if (!shouldThisProcessOwnLateralCron()) {
    console.info(
      `[executive-scheduler] Cron not armed in this process (${schedulerOwnershipReason()}).`
    );
    return getExecutiveSchedulerStatus();
  }

  if (!isExecutiveDatasetSchedulerAutoEnabled()) {
    console.info(
      `[executive-scheduler] Automatic cron not armed (${executiveDatasetSchedulerPolicyReason()}). Manual invokeExecutiveJob("manual") is unchanged.`
    );
    return getExecutiveSchedulerStatus();
  }

  const config = await readExecutiveSchedulerConfig();
  if (!config.enabled || config.paused) {
    console.info(
      `[executive-scheduler] Cron not armed — executive_scheduler_state.enabled=${config.enabled}, paused=${config.paused}.`
    );
    return getExecutiveSchedulerStatus();
  }

  let expressions: string[];
  try {
    expressions = expressionsForConfig(config);
  } catch (error) {
    console.error(
      "[executive-scheduler] Invalid schedule — not armed:",
      error instanceof Error ? error.message : error
    );
    return getExecutiveSchedulerStatus();
  }

  rt.cronArmedAtMs = Date.now();
  const timezone = config.timezone;

  expressions.forEach((expression, index) => {
    const task = cron.schedule(
      expression,
      () => {
        void runExecutiveScheduledTick(timezone).catch((error) => {
          console.error("[executive-scheduler] Scheduled tick failed", error);
        });
      },
      {
        timezone,
        noOverlap: true,
        name: `executive-scheduler-${index}`,
        missedExecutionTolerance: 0,
      }
    );
    rt.tasks.set(`executive::${index}`, task);
  });

  console.info(
    `[executive-scheduler] Armed ${config.frequency} times=${config.frequency === "custom" ? config.customTimes.join(",") : config.syncTime} TZ=${timezone} cron=[${expressions.join(" | ")}] (startup will not replay the current minute)`
  );
  return getExecutiveSchedulerStatus();
}

async function runExecutiveScheduledTick(timezone: string) {
  if (
    shouldSkipScheduledTickAfterArm({
      armedAtMs: rt.cronArmedAtMs,
      nowMs: Date.now(),
      timezone,
    })
  ) {
    console.info(
      "[executive-scheduler] Skipping scheduled tick in the same minute as process arm (no missed-run catch-up)."
    );
    return;
  }
  const config = await readExecutiveSchedulerConfig();
  if (!config.enabled || config.paused) return;
  if (!isExecutiveDatasetSchedulerAutoEnabled()) return;

  try {
    // A held lock comes back as status "busy" (not a throw), but an
    // unexpected job crash or a failed state write still throws — never let
    // that escape a cron callback as an unhandled rejection.
    await runExecutiveJobAndPersist("scheduler");
  } catch (error) {
    console.error("[executive-scheduler] Scheduled tick failed", error);
  }
}

/**
 * Shared entry for cron ticks + a future manual "Run Now" (Phase E8):
 * runs the job (lock/sync/reconcile/checkpoint all inside invokeExecutiveJob,
 * Phase E4) then persists the outcome into executive_scheduler_state so a
 * future Dataset Manager page has something to display.
 */
export async function runExecutiveJobAndPersist(
  trigger: "scheduler" | "manual",
  /** Test-only: inject fake deps to avoid live Gmail/Drive credentials. */
  deps?: InvokeExecutiveJobDeps
): Promise<ExecutiveJobOutcome> {
  console.info(`[executive-scheduler] Starting Executive job (${trigger})`);
  // Counter, not a boolean: a Run Now overlapping a cron tick gets "busy"
  // from the advisory lock and decrements at once without clearing the
  // running job's count. The lock stays the real mutual exclusion.
  rt.runningJobs += 1;
  let outcome: ExecutiveJobOutcome;
  try {
    outcome = await invokeExecutiveJob(trigger, deps);
  } finally {
    rt.runningJobs -= 1;
  }

  if (outcome.status !== "busy") {
    await writeExecutiveSchedulerConfig({
      lastRunAt: outcome.ranAt,
      lastRunStatus: outcome.status,
      lastRunMessage: outcome.message,
      lastDurationMs: outcome.durationMs,
      lastTrigger: trigger,
      lastRunSummary: outcome.summary,
    });

    // Skip a history row when nothing was actually attempted (idle tick /
    // no new source, or the summary is otherwise empty) — mirrors not
    // recording a "no-op" as a pipeline run. Lateral's own history is
    // similarly only meaningful once a source was processed or an attempt
    // genuinely failed.
    const summary = outcome.summary;
    if (summary && !(summary.noNewSource && outcome.status !== "failed")) {
      await appendExecutiveSyncHistory({
        syncTime: outcome.ranAt,
        sourceEmail: formatExecutiveSourceEmail(summary),
        originalFilename: summary.sourceFilename || "—",
        googleDriveFileId: summary.driveFileId || "—",
        rowsImported: summary.counts?.rowsImported ?? 0,
        newCount: summary.counts?.newCount ?? 0,
        activeCount: summary.counts?.activeCount ?? 0,
        reopenCount: summary.counts?.reopenCount ?? 0,
        closedCount: summary.counts?.closedCount ?? 0,
        result: outcome.status === "success" ? "Success" : "Failed",
        error: outcome.status === "success" ? null : summary.failureReason || outcome.message,
        trigger,
        durationMs: outcome.durationMs,
      }).catch((err) => {
        console.warn("[executive-scheduler] Failed to append sync history", err);
      });
    }
  }

  console.info(`[executive-scheduler] ${outcome.status}: ${outcome.message}`);
  return outcome;
}

/** Mirrors lateral-scheduler.ts's formatEmailInfo — display-only, never tokens. */
function formatExecutiveSourceEmail(
  summary: NonNullable<ExecutiveJobOutcome["summary"]>
): string {
  const bits: string[] = [];
  if (summary.sender?.trim()) bits.push(summary.sender.trim());
  if (summary.subject?.trim()) bits.push(summary.subject.trim());
  if (bits.length === 0 && summary.messageId) {
    bits.push(`Message ${summary.messageId}`);
  }
  return bits.length > 0 ? bits.join(" · ") : "—";
}

export async function reloadExecutiveScheduler(): Promise<ExecutiveSchedulerStatus> {
  return armExecutiveCron();
}

export async function startExecutiveScheduler(): Promise<void> {
  if (!shouldThisProcessOwnLateralCron()) {
    console.info(
      `[executive-scheduler] Scheduler bootstrap skipped in this process (${schedulerOwnershipReason()}).`
    );
    rt.bootstrapped = true;
    return;
  }

  if (!isExecutiveDatasetSchedulerAutoEnabled()) {
    console.info(
      `[executive-scheduler] Automatic cron disabled (${executiveDatasetSchedulerPolicyReason()}). Manual invokeExecutiveJob("manual") is unchanged.`
    );
    rt.bootstrapped = true;
    return;
  }

  await armExecutiveCron();
  rt.bootstrapped = true;
}

export async function ensureExecutiveSchedulerStarted(): Promise<ExecutiveSchedulerStatus> {
  if (!rt.bootstrapped) {
    await startExecutiveScheduler();
  }
  return getExecutiveSchedulerStatus();
}

export async function pauseExecutiveScheduler(): Promise<ExecutiveSchedulerStatus> {
  await writeExecutiveSchedulerConfig({ paused: true });
  return armExecutiveCron();
}

export async function resumeExecutiveScheduler(): Promise<ExecutiveSchedulerStatus> {
  await writeExecutiveSchedulerConfig({ paused: false, enabled: true });
  return armExecutiveCron();
}

export async function updateExecutiveScheduler(input: {
  frequency?: ScheduleFrequency;
  syncTime?: string;
  dayOfWeek?: number;
  customDays?: number[];
  customTimes?: string[];
  timezone?: string;
  enabled?: boolean;
  paused?: boolean;
}): Promise<ExecutiveSchedulerStatus> {
  // Only forward keys the caller actually provided. PostgresSchedulerStateStore
  // merges via `{...prior, ...partial}` — an explicit `undefined` value for a
  // provided key would otherwise overwrite a valid prior value with NULL
  // (postgres.js rejects `undefined` outright). Lateral's own
  // `updateLateralScheduler` has this same latent gap (untouched, not fixed
  // there — out of scope); Executive's own version avoids inheriting it.
  //
  // Times/days are normalized here because the Postgres write path stores
  // them verbatim, and `buildCronExpressionsFromSchedule` silently turns an
  // unparseable time into 07:00.
  const isHhMm = (value: unknown) =>
    typeof value === "string" && /^\d{1,2}:\d{2}$/.test(value.trim());
  if (input.syncTime !== undefined && !isHhMm(input.syncTime)) {
    throw new Error(`Invalid sync time "${input.syncTime}" — use HH:MM.`);
  }
  const badTime = input.customTimes?.find((time) => !isHhMm(time));
  if (badTime !== undefined) {
    throw new Error(`Invalid schedule time "${badTime}" — use HH:MM.`);
  }
  const partial: Partial<ExecutiveSchedulerConfig> = {};
  if (input.frequency !== undefined) partial.frequency = input.frequency;
  if (input.syncTime !== undefined) partial.syncTime = normalizeHhMm(input.syncTime);
  if (input.dayOfWeek !== undefined) partial.dayOfWeek = input.dayOfWeek;
  if (input.customDays !== undefined) {
    partial.customDays = normalizeCustomDays(input.customDays);
  }
  if (input.customTimes !== undefined) {
    partial.customTimes = normalizeCustomTimes(input.customTimes);
  }
  if (partial.frequency === "custom") {
    if (partial.customDays !== undefined && partial.customDays.length === 0) {
      throw new Error("Custom schedule needs at least one day selected.");
    }
    if (partial.customTimes !== undefined && partial.customTimes.length === 0) {
      throw new Error("Custom schedule needs at least one valid time (HH:MM).");
    }
  }
  if (input.timezone !== undefined) partial.timezone = input.timezone;
  if (input.enabled !== undefined) partial.enabled = input.enabled;
  if (input.paused !== undefined) partial.paused = input.paused;
  await writeExecutiveSchedulerConfig(partial);
  return armExecutiveCron();
}

/**
 * Safe Executive processing status for Dataset UI (no OAuth tokens/secrets).
 * Mirrors `getLateralProcessingStatusView` (Phase E8).
 */
export async function getExecutiveProcessingStatusView(): Promise<ExecutiveProcessingStatusView> {
  const [scheduler, connections, checkpoint, history] = await Promise.all([
    getExecutiveSchedulerStatus(),
    getSharedGoogleConnectionStatus({ probeDrive: false }),
    readExecutiveGmailCheckpoint(),
    listExecutiveSyncHistory(1),
  ]);

  const lastResult: ExecutiveProcessingStatusView["lastResult"] =
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
    datasetName: "Executive",
    gmail: {
      connected: Boolean(connections.gmail?.connected),
      email: connections.email ?? null,
    },
    drive: {
      connected: Boolean(connections.drive?.connected),
    },
    schedule: {
      frequency:
        SCHEDULE_FREQUENCY_LABELS[scheduler.frequency] || scheduler.frequency,
      syncTime: scheduler.syncTime,
      timeLabel: scheduler.timeLabel,
      timezone: scheduler.timezone,
    },
    status: scheduler.statusLabel,
    notArmedReason: scheduler.notArmedReason,
    lastSuccessfulSync:
      checkpoint.processedAt ||
      (scheduler.lastRunStatus === "success" ? scheduler.lastRunAt : null),
    lastProcessedFile:
      checkpoint.attachmentFilename ||
      (latestHistory?.originalFilename !== "—"
        ? (latestHistory?.originalFilename ?? null)
        : null),
    lastProcessedEmail,
    lastResult,
    nextScheduledRun: scheduler.nextRunAt,
    running: scheduler.running,
    lastRunMessage: scheduler.lastRunMessage,
    lastRunSummary: scheduler.lastRunSummary ?? null,
    runProgress: null,
  };
}
