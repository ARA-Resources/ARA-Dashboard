import { randomUUID } from "node:crypto";
import { clearSkillClusterCache } from "@/services/excel/extract-skill-clusters";
import { clearExcelCache } from "@/services/excel/reader";
import { pushAppNotification } from "@/services/dataset/notifications-store";
import { readDatasetSetup } from "@/services/dataset/secure-store";
import { runScheduledDatasetSync } from "@/services/dataset/sync-download";
import {
  appendSyncHistoryEntries,
  buildSyncHistoryEntries,
  notificationCopyForHistoryEntry,
} from "@/services/dataset/sync-history-store";
import { sendFailureEmailAlert } from "@/services/dataset/failure-email";
import { markSuccessfulSync } from "@/services/dataset/sync-watermark-store";
import type { DatasetSyncResult } from "@/types/dataset-sync";
import type { DatasetSyncName } from "@/types/dataset-sync";
import {
  EXECUTABLE_DATASET_TYPES,
  resolveExecutableDatasetNamesForRun,
} from "@/types/dataset-execution";

export type AutomatedSyncTrigger = "scheduler" | "manual" | "api";

export interface AutomatedSyncOutcome {
  trigger: AutomatedSyncTrigger;
  ranAt: string;
  result: DatasetSyncResult;
  status: "success" | "partial" | "failed";
  message: string;
  notificationIds: string[];
  historyEntryIds: string[];
}

function summarizeResult(result: DatasetSyncResult): {
  status: "success" | "partial" | "failed";
  message: string;
} {
  if (result.failedCount > 0 && result.downloadedCount === 0) {
    return {
      status: "failed",
      message: `Dataset sync failed for ${result.failedCount} file(s). Existing current datasets were preserved.`,
    };
  }

  if (result.failedCount > 0) {
    return {
      status: "partial",
      message: `Synced ${result.validatedCount} file(s), uploaded ${result.uploadedCount}; ${result.failedCount} failed. Dashboard cache refreshed.`,
    };
  }

  if (result.downloadedCount === 0) {
    return {
      status: "success",
      message:
        "Scheduled sync completed — no new Excel attachments. Dataset Manager and dashboard cache are up to date.",
    };
  }

  return {
    status: "success",
    message: `Synced ${result.validatedCount} Excel file(s), uploaded ${result.uploadedCount} to Drive. Dataset Manager and dashboard refreshed.`,
  };
}

function driveDestinationLabel(
  setup: Awaited<ReturnType<typeof readDatasetSetup>>
) {
  if (!setup) return "Google Drive";
  const mapped = EXECUTABLE_DATASET_TYPES.map((name) => {
    const folder = setup.datasets?.[name]?.driveFolder;
    const label =
      folder?.folderName?.trim() || folder?.folderId?.trim() || null;
    return label ? `${name}→${label}` : null;
  }).filter(Boolean);
  if (mapped.length > 0) {
    return `${mapped.join(", ")} (${setup.driveAccountEmail || "Drive"})`;
  }
  return setup.driveAccountEmail || "Google Drive";
}

function emptySyncResult(ranAt: string): DatasetSyncResult {
  return {
    ranAt,
    query: "",
    connectedEmail: null,
    items: [],
    logs: [],
    downloadedCount: 0,
    validatedCount: 0,
    uploadedCount: 0,
    failedCount: 0,
    preservedCurrentCount: 0,
  };
}

/**
 * Dataset automation entry point.
 *
 * SCOPE: Only Lateral executes currently — routed to the dedicated Lateral job
 * (Gmail checkpoint → Drive → Master pipeline). Executive/Consulting never run.
 * Shared Gmail/Drive connection remains common for future independent processors.
 */
export async function runAutomatedDatasetSync(
  trigger: AutomatedSyncTrigger = "scheduler",
  options?: {
    scheduleId?: string;
    scheduleName?: string;
    datasetNames?: DatasetSyncName[];
  }
): Promise<AutomatedSyncOutcome> {
  const { executable, skippedFuture } = resolveExecutableDatasetNamesForRun(
    options?.datasetNames
  );

  // Lateral is the only executable type — always use the dedicated Lateral job.
  if (executable.includes("Lateral")) {
    const { invokeLateralJob } = await import(
      "@/services/lateral-processing/lateral-scheduler"
    );
    const lateralTrigger = trigger === "scheduler" ? "scheduler" : "manual";
    const { outcome } = await invokeLateralJob(lateralTrigger);

    const skippedNote =
      skippedFuture.length > 0
        ? ` Skipped not-yet-enabled: ${skippedFuture.join(", ")}.`
        : "";

    return {
      trigger,
      ranAt: outcome.ranAt,
      result: emptySyncResult(outcome.ranAt),
      status: outcome.status,
      message: `${outcome.message}${skippedNote}`,
      notificationIds: [],
      historyEntryIds: [],
    };
  }

  throw new Error(
    "No executable dataset types. Only Lateral Dataset automation runs currently."
  );
}

/**
 * Legacy multi-dataset Gmail→Drive sync (download/upload only).
 * Hard-gated to executable types. Prefer runAutomatedDatasetSync for jobs.
 */
export async function runLegacyExecutableDatasetSync(
  trigger: AutomatedSyncTrigger = "manual",
  options?: {
    scheduleId?: string;
    scheduleName?: string;
    datasetNames?: DatasetSyncName[];
  }
): Promise<AutomatedSyncOutcome> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const { executable, skippedFuture } = resolveExecutableDatasetNamesForRun(
    options?.datasetNames
  );

  const result = await runScheduledDatasetSync({
    datasetNames: [...executable],
    scanMode: "incremental",
  });

  const finishedAt = new Date().toISOString();
  const durationMs = Math.max(0, Date.now() - startedMs);

  clearExcelCache();
  clearSkillClusterCache();

  const setup = await readDatasetSetup();
  const downloadedFrom =
    result.connectedEmail || setup?.gmailAddress || "Gmail";
  const uploadedTo = driveDestinationLabel(setup);

  const historyEntries = buildSyncHistoryEntries({
    runId,
    trigger,
    startedAt,
    finishedAt,
    durationMs,
    result,
    downloadedFrom,
    uploadedTo,
  });
  await appendSyncHistoryEntries(historyEntries);

  const notificationIds: string[] = [];
  for (const entry of historyEntries) {
    if (entry.status === "skipped") continue;

    const isFailure = entry.status === "failed";
    const allowNotify = isFailure
      ? setup?.notifyOnFailure !== false
      : Boolean(setup?.notifyOnSuccess);

    if (!allowNotify) continue;

    const copy = notificationCopyForHistoryEntry(entry);
    const schedulePrefix = options?.scheduleName
      ? `${options.scheduleName}: `
      : "";
    const notification = await pushAppNotification({
      kind: copy.kind,
      title: `${schedulePrefix}${copy.title}`,
      body: copy.body,
      href: "/dataset/sync-history",
      meta: {
        trigger,
        runId,
        scheduleId: options?.scheduleId,
        historyEntryId: entry.id,
        dataset: entry.dataset,
        status: entry.status,
        fileName: entry.fileName,
        checksumSha256: entry.checksumSha256,
      },
    });
    notificationIds.push(notification.id);

    if (isFailure) {
      await sendFailureEmailAlert({
        subject: `[ARA] ${schedulePrefix}${copy.title}`,
        body: [
          copy.body,
          "",
          `Dataset: ${entry.dataset}`,
          `File: ${entry.fileName}`,
          `Errors: ${entry.errors ?? "n/a"}`,
          `Checksum: ${entry.checksumSha256 ?? "n/a"}`,
          `Time: ${entry.syncTime}`,
          `Open: /dataset/sync-history`,
        ].join("\n"),
        toOverride: setup?.alertEmail || undefined,
      });
    }
  }

  const summary = summarizeResult(result);
  if (summary.status !== "failed") {
    await markSuccessfulSync({ at: finishedAt, trigger });
  }

  const skippedNote =
    skippedFuture.length > 0
      ? ` Skipped not-yet-enabled: ${skippedFuture.join(", ")}.`
      : "";

  return {
    trigger,
    ranAt: startedAt,
    result,
    status: summary.status,
    message: `${summary.message}${skippedNote}`,
    notificationIds,
    historyEntryIds: historyEntries.map((entry) => entry.id),
  };
}
