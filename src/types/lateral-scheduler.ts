import type { ScheduleFrequency } from "@/types/dataset-schedule";

export type LateralJobTrigger = "scheduler" | "manual";

export type LateralJobStatus = "success" | "partial" | "failed";

export interface LateralRunLastSummary {
  result: LateralJobStatus;
  ranAt: string;
  trigger: LateralJobTrigger;
  /** Source attachment / Adhoc DS filename when a new file was processed */
  sourceFilename: string | null;
  /**
   * Best "which Adhoc DS this run is for" date as DD-MM-YYYY
   * (email receivedAt preferred), or null when no new source.
   */
  adhocDsDate: string | null;
  /** Ready-to-show line, e.g. "Last Adhoc DS: 03-09-2026" */
  adhocDsDateLabel: string;
  failureReason: string | null;
  noNewSource: boolean;
  counts: {
    rowsImported: number;
    newCount: number;
    activeCount: number;
    reopenCount: number;
    closedCount: number;
  } | null;
}

export interface LateralSchedulerConfig {
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
  lastRunStatus: LateralJobStatus | null;
  lastRunMessage: string | null;
  lastDurationMs: number | null;
  lastTrigger: LateralJobTrigger | null;
  /** Durable last Run All summary for Master Sheet banner + notifications */
  lastRunSummary: LateralRunLastSummary | null;
}

export interface LateralSchedulerStatus extends LateralSchedulerConfig {
  datasetName: "Lateral";
  statusLabel: "Active" | "Paused" | "Disabled";
  nextRunAt: string | null;
  running: boolean;
  cronExpression: string;
  cronExpressions: string[];
  timeLabel: string;
  /** Last successfully processed Lateral Gmail email/file cursor */
  gmailCheckpoint?: {
    messageId: string | null;
    receivedAt: string | null;
    attachmentFilename: string | null;
    driveFileId: string | null;
    processedAt: string | null;
  };
}

export interface LateralJobOutcome {
  trigger: LateralJobTrigger;
  ranAt: string;
  status: LateralJobStatus;
  message: string;
  syncOk: boolean;
  pipelineOk: boolean;
  durationMs: number;
  /** Present when any stage failed or ended in a clear non-success terminal state */
  failure?: {
    code: string;
    stage: string;
    failedStage: string;
    message: string;
    checkpointAdvanced: false;
    previousMasterPreserved: true;
    retryable: true;
    reportedSuccess: false;
    isHardFailure: boolean;
  } | null;
  checkpointAdvanced: boolean;
  /** Safe fields for UI / sync history (no tokens) */
  syncSummary?: {
    sourceEmail: string;
    originalFilename: string;
    googleDriveFileId: string;
    /** ISO receivedAt of the Adhoc DS / source email when available */
    sourceReceivedAt: string | null;
    rowsImported: number;
    newCount: number;
    activeCount: number;
    reopenCount: number;
    closedCount: number;
  } | null;
}

export type LateralRunStageStatus =
  | "pending"
  | "active"
  | "ok"
  | "failed"
  | "skipped";

export interface LateralRunStageProgress {
  id: string;
  label: string;
  status: LateralRunStageStatus;
  detail?: string;
}

export interface LateralRunProgressSnapshot {
  active: boolean;
  trigger: LateralJobTrigger | null;
  startedAt: string | null;
  finishedAt: string | null;
  currentStageId: string | null;
  currentStageLabel: string;
  stages: LateralRunStageProgress[];
  pipelineStep: number | null;
  pipelineStepTotal: number;
}

export interface LateralProcessingStatusView {
  datasetName: "Lateral";
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
  lastResult: "Success" | "Failed" | "Partial" | null;
  nextScheduledRun: string | null;
  running: boolean;
  lastRunMessage: string | null;
  /** Last Run All summary for Master Sheet status strip */
  lastRunSummary: LateralRunLastSummary | null;
  runProgress: LateralRunProgressSnapshot | null;
}
