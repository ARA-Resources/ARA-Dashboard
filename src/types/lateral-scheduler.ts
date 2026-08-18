import type { ScheduleFrequency } from "@/types/dataset-schedule";

export type LateralJobTrigger = "scheduler" | "manual";

export type LateralJobStatus = "success" | "partial" | "failed";

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
  runProgress: LateralRunProgressSnapshot | null;
}
