import type { ScheduleFrequency } from "@/types/dataset-schedule";

/**
 * Executive scheduler config type — mirrors LateralSchedulerConfig
 * (`src/types/lateral-scheduler.ts`) structurally.
 *
 * Phase E1: this type backs `executive_scheduler_state` persistence only.
 * No cron logic reads/writes it yet — that lands in Phase E5
 * (`executive-scheduler.ts`), mirroring `lateral-scheduler.ts`.
 */

export const DEFAULT_EXECUTIVE_TIMEZONE = "Asia/Kolkata" as const;

export type ExecutiveJobTrigger = "scheduler" | "manual";

export type ExecutiveJobStatus = "success" | "partial" | "failed";

export interface ExecutiveRunLastSummary {
  result: ExecutiveJobStatus;
  ranAt: string;
  trigger: ExecutiveJobTrigger;
  /** Source attachment filename (ATCI Exec DS_<date>.xlsx) when a new file was processed */
  sourceFilename: string | null;
  /** Display-only Gmail metadata (never tokens) — Phase E8 sync-history display */
  sender: string | null;
  subject: string | null;
  driveFileId: string | null;
  messageId: string | null;
  /** Best "which demand sheet this run is for" date as DD-MM-YYYY, or null when no new source */
  demandSheetDate: string | null;
  /** Ready-to-show line, e.g. "Last demand sheet: 09-09-2026" */
  demandSheetDateLabel: string;
  failureReason: string | null;
  noNewSource: boolean;
  counts: {
    rowsImported: number;
    newCount: number;
    activeCount: number;
    reopenCount: number;
    closedCount: number;
  } | null;
  /**
   * Phase E6 — Posted Sheet full refresh. `ok: false` means the source was
   * unreadable and `executive_master.posted` was NOT touched this run (never
   * a hard job failure — see `executive-job.ts`).
   */
  postedRefresh: {
    ok: boolean;
    message: string;
    postedYes: number | null;
    postedDash: number | null;
  } | null;
}

/**
 * Result of one `invokeExecutiveJob()` run (Phase E4).
 * "busy" means `acquireExecutiveJobLock()` did not acquire — another
 * Executive run is already in progress; nothing else in the job ran.
 */
export interface ExecutiveJobOutcome {
  trigger: ExecutiveJobTrigger;
  ranAt: string;
  status: ExecutiveJobStatus | "busy";
  message: string;
  durationMs: number;
  lockAcquired: boolean;
  syncOk: boolean;
  reconcileOk: boolean;
  checkpointAdvanced: boolean;
  /**
   * Phase E6. Best-effort — a Posted Sheet read failure never fails the
   * overall job or blocks the checkpoint advance (see module doc in
   * `executive-job.ts`). `null` when no reconcile ran this call (busy, or
   * sync-stage failure) so Posted refresh was never attempted.
   */
  postedRefreshOk: boolean | null;
  /** null only when status === "busy" (nothing ran). */
  summary: ExecutiveRunLastSummary | null;
}

export interface ExecutiveSchedulerStatus extends ExecutiveSchedulerConfig {
  datasetName: "Executive";
  statusLabel: "Active" | "Paused" | "Disabled";
  nextRunAt: string | null;
  running: boolean;
  cronExpression: string;
  cronExpressions: string[];
  timeLabel: string;
  gmailCheckpoint?: {
    messageId: string | null;
    receivedAt: string | null;
    attachmentFilename: string | null;
    driveFileId: string | null;
    processedAt: string | null;
  };
}

/**
 * Safe Executive processing status for Dataset UI (no OAuth tokens/secrets).
 * Mirrors `LateralProcessingStatusView` — `runProgress` is always `null` for
 * now: Executive has no live multi-stage progress tracking yet
 * (`invokeExecutiveJob` runs as one synchronous request/response, unlike
 * Lateral's background-pollable `lateral-run-progress.ts`); the Run All
 * button shows a simple busy/result state instead of a live stage list.
 */
export interface ExecutiveProcessingStatusView {
  datasetName: "Executive";
  gmail: { connected: boolean; email: string | null };
  drive: { connected: boolean };
  schedule: {
    frequency: string;
    syncTime: string;
    timeLabel: string;
    timezone: string;
  };
  status: "Active" | "Paused" | "Disabled";
  lastSuccessfulSync: string | null;
  lastProcessedFile: string | null;
  lastProcessedEmail: string | null;
  lastResult: "Success" | "Partial" | "Failed" | null;
  nextScheduledRun: string | null;
  running: boolean;
  lastRunMessage: string | null;
  lastRunSummary: ExecutiveRunLastSummary | null;
  runProgress: null;
}

export interface ExecutiveSchedulerConfig {
  version: 1;
  frequency: ScheduleFrequency;
  /** HH:mm primary / fallback time */
  syncTime: string;
  /** Weekly day (0=Sun … 6=Sat) */
  dayOfWeek: number;
  /** Custom selected days */
  customDays: number[];
  /** One or more HH:mm times (custom / multi-time) */
  customTimes: string[];
  timezone: string;
  enabled: boolean;
  paused: boolean;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: ExecutiveJobStatus | null;
  lastRunMessage: string | null;
  lastDurationMs: number | null;
  lastTrigger: ExecutiveJobTrigger | null;
  /** Durable last Run All summary — for a future Dataset page banner (Phase E8/UI) */
  lastRunSummary: ExecutiveRunLastSummary | null;
}
