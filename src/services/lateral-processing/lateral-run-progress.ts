/**
 * In-memory Lateral Run All / scheduler job progress (single-flight).
 * Updated by executeLateralDatasetJob + runLateralDatasetPipeline during a run.
 * Safe to poll via GET /api/dataset/lateral/scheduler while run_now is in flight.
 */

import type {
  LateralRunProgressSnapshot,
  LateralRunStageProgress,
  LateralRunStageStatus,
} from "@/types/lateral-scheduler";

export type { LateralRunProgressSnapshot, LateralRunStageProgress, LateralRunStageStatus };

/** Keep in sync with pipeline.ts PIPELINE_STEPS (labels only — avoids circular imports). */
const PIPELINE_STAGE_LABELS = [
  { step: 1, name: "Read Lateral Dataset Configuration" },
  { step: 2, name: "Find latest configured source Excel file in Google Drive" },
  { step: 3, name: "Verify the source workbook exists" },
  { step: 4, name: "Open the configured source worksheet (ATCI DS)" },
  { step: 5, name: "Read the source data" },
  { step: 6, name: "Discover Master Workbook (.xlsm) by exact configured name" },
  { step: 7, name: "Validate Master Sheet and New Sheet exist" },
  { step: 8, name: "Validate New Sheet Row 1 header structure (exact A–J order)" },
  { step: 9, name: "Match source columns to New Sheet headers and validate mapping" },
  { step: 10, name: "Create backup/version of Master Workbook" },
  { step: 11, name: "Clear old New Sheet DATA ONLY (keep Row 1 headers)" },
  { step: 12, name: "Insert ATCI DS data via validated header mapping" },
  { step: 13, name: "Set Column A Date to current processing date (DD-MM-YYYY)" },
  { step: 14, name: "Compare Job Requisition IDs (New Sheet ↔ Master Sheet, no status changes)" },
  { step: 15, name: "Apply New / Reopen / Closed / Active unchanged rules" },
  { step: 16, name: "Generate reconciliation report" },
  { step: 17, name: "Validate everything" },
  { step: 18, name: "Clean Posted Sheet A/B/C and match Master Sheet Posted (Column M)" },
  { step: 19, name: "Refresh P-Roles PivotTable1 from Master Sheet (Posted filter)" },
  { step: 20, name: "Save Master Workbook" },
  { step: 21, name: "Skip conflicting status macro (Dataset owns Column K)" },
  { step: 22, name: "Verify status-safe VBA finalize (stub / no overwrite)" },
  { step: 23, name: "Save final Master Workbook" },
  { step: 24, name: "Upload/update the final Master Workbook in the configured Google Drive destination" },
  { step: 25, name: "Update Dataset Manager" },
] as const;

export const LATERAL_RUN_GMAIL_STAGES = [
  { id: "gmail_search", label: "Fetching Gmail source" },
  { id: "gmail_download", label: "Downloading source workbook" },
  { id: "drive_upload", label: "Uploading source to Drive" },
  { id: "drive_replace", label: "Applying source file replacement policy" },
] as const;

let snapshot: LateralRunProgressSnapshot = idleSnapshot();

function idleSnapshot(): LateralRunProgressSnapshot {
  return {
    active: false,
    trigger: null,
    startedAt: null,
    finishedAt: null,
    currentStageId: null,
    currentStageLabel: "",
    stages: [],
    pipelineStep: null,
    pipelineStepTotal: PIPELINE_STAGE_LABELS.length,
  };
}

function buildDefaultStages(): LateralRunStageProgress[] {
  const gmail = LATERAL_RUN_GMAIL_STAGES.map((s) => ({
    id: s.id,
    label: s.label,
    status: "pending" as const,
  }));
  const pipeline = PIPELINE_STAGE_LABELS.map((s) => ({
    id: `pipeline_${s.step}`,
    label: s.name,
    status: "pending" as const,
  }));
  return [...gmail, ...pipeline, { id: "home_metrics", label: "Refresh Home metrics", status: "pending" }];
}

export function startLateralRunProgress(trigger: "manual" | "scheduler"): void {
  snapshot = {
    active: true,
    trigger,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    currentStageId: LATERAL_RUN_GMAIL_STAGES[0].id,
    currentStageLabel: LATERAL_RUN_GMAIL_STAGES[0].label,
    stages: buildDefaultStages(),
    pipelineStep: null,
    pipelineStepTotal: PIPELINE_STAGE_LABELS.length,
  };
}

export function finishLateralRunProgress(options?: {
  failedStageId?: string;
  skippedRemaining?: boolean;
}): void {
  const finishedAt = new Date().toISOString();
  if (options?.failedStageId) {
    snapshot.stages = snapshot.stages.map((s) => {
      if (s.id === options.failedStageId) return { ...s, status: "failed" };
      if (s.status === "pending" || s.status === "active") {
        return options.skippedRemaining
          ? { ...s, status: "skipped" as const }
          : s;
      }
      return s;
    });
  }
  if (options?.skippedRemaining && !options.failedStageId) {
    snapshot.stages = snapshot.stages.map((s) =>
      s.status === "pending" || s.status === "active"
        ? { ...s, status: "skipped" as const }
        : s
    );
  }
  const completedLabel = options?.failedStageId
    ? snapshot.currentStageLabel
    : "Completed";
  snapshot = {
    ...snapshot,
    active: false,
    finishedAt,
    currentStageId: null,
    currentStageLabel: completedLabel,
  };
}

export function updateLateralGmailProgress(
  stageId: (typeof LATERAL_RUN_GMAIL_STAGES)[number]["id"],
  status: Exclude<LateralRunStageStatus, "pending">,
  detail?: string
): void {
  if (!snapshot.active) return;
  const label =
    LATERAL_RUN_GMAIL_STAGES.find((s) => s.id === stageId)?.label ?? stageId;
  snapshot.stages = snapshot.stages.map((s) => {
    if (s.id === stageId) return { ...s, status, detail };
    return s;
  });
  if (status === "active") {
    snapshot.currentStageId = stageId;
    snapshot.currentStageLabel = label;
  }
}

export function updateLateralPipelineProgress(
  step: number,
  status: "active" | "ok" | "failed" | "skipped",
  detail?: string
): void {
  if (!snapshot.active) return;
  const id = `pipeline_${step}`;
  const def = PIPELINE_STAGE_LABELS.find((s) => s.step === step);
  const label = def?.name ?? `Pipeline step ${step}`;
  snapshot.stages = snapshot.stages.map((s) => {
    if (s.id === id) return { ...s, status, detail };
    return s;
  });
  if (status === "active") {
    snapshot.pipelineStep = step;
    snapshot.currentStageId = id;
    snapshot.currentStageLabel = label;
  } else if (status === "ok") {
    snapshot.pipelineStep = step;
  }
}

export function updateLateralHomeMetricsProgress(
  status: "active" | "ok" | "skipped" | "failed",
  detail?: string
): void {
  if (!snapshot.active) return;
  snapshot.stages = snapshot.stages.map((s) =>
    s.id === "home_metrics" ? { ...s, status, detail } : s
  );
  if (status === "active") {
    snapshot.currentStageId = "home_metrics";
    snapshot.currentStageLabel = "Refresh Home metrics";
  }
}

export function markLateralRunIdleAfterNoNewSource(message: string): void {
  if (!snapshot.active) return;
  snapshot.stages = snapshot.stages.map((s) =>
    s.id.startsWith("pipeline_") || s.id === "home_metrics"
      ? { ...s, status: "skipped", detail: message }
      : s
  );
  snapshot.currentStageLabel = message;
}

export function getLateralRunProgress(): LateralRunProgressSnapshot {
  return { ...snapshot, stages: [...snapshot.stages] };
}

export function resetLateralRunProgress(): void {
  snapshot = idleSnapshot();
}
