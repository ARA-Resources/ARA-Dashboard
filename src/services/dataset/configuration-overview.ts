import {
  getDatasetDriveFolderConfig,
  resolveDriveFolderIdForDataset,
} from "@/services/drive/folder";
import { getLocalDatasetDriveFolderStatistics } from "@/services/drive/folder-stats";
import { listCurrentDatasetFiles } from "@/services/dataset/resolve-current";
import { readDatasetSetup } from "@/services/dataset/secure-store";
import { getDatasetSchedulerStatusAsync } from "@/services/dataset/scheduler";
import { listSyncHistory } from "@/services/dataset/sync-history-store";
import { readSyncWatermark } from "@/services/dataset/sync-watermark-store";
import { getGmailConnectionStatus } from "@/services/gmail/scan";
import { DATASET_SYNC_NAMES } from "@/types/dataset-sync";
import type {
  DatasetAutomationHealthStatus,
  DatasetConfigOverviewRow,
  DatasetConfigurationOverview,
} from "@/types/dataset-config-overview";

function driveOpenUrl(folderId: string, folderUrl?: string) {
  if (folderUrl?.includes("drive.google.com")) return folderUrl;
  if (!folderId || folderId === "—") return null;
  return `https://drive.google.com/drive/folders/${folderId}`;
}

function deriveStatus(input: {
  configured: boolean;
  enabled: boolean;
  hasFolder: boolean;
  hasSendersOrKeywords: boolean;
  schedulesPaused: boolean;
  hasActiveSchedule: boolean;
  lastSyncStatus: string | null;
  gmailConnected: boolean;
}): { status: DatasetAutomationHealthStatus; statusDetail: string } {
  if (!input.configured) {
    return {
      status: "Not configured",
      statusDetail: "Complete Dataset setup to enable automation.",
    };
  }
  if (!input.enabled) {
    return {
      status: "Disabled",
      statusDetail: "Dataset search is disabled in configuration.",
    };
  }
  if (!input.hasFolder) {
    return {
      status: "Attention",
      statusDetail: "Google Drive folder is not mapped.",
    };
  }
  if (!input.hasSendersOrKeywords) {
    return {
      status: "Attention",
      statusDetail: "No enabled keywords configured.",
    };
  }
  if (!input.gmailConnected) {
    return {
      status: "Attention",
      statusDetail: "Gmail OAuth is not connected.",
    };
  }
  if (input.schedulesPaused || !input.hasActiveSchedule) {
    return {
      status: "Paused",
      statusDetail: input.schedulesPaused
        ? "All related schedules are paused or disabled."
        : "No active schedule includes this dataset.",
    };
  }
  if (input.lastSyncStatus === "failed") {
    return {
      status: "Error",
      statusDetail: "Last sync failed — check Sync History logs.",
    };
  }
  return {
    status: "Healthy",
    statusDetail: "Configured, scheduled, and ready to sync.",
  };
}

export async function getDatasetConfigurationOverview(): Promise<DatasetConfigurationOverview> {
  const setup = await readDatasetSetup();
  const [
    scheduler,
    gmail,
    folderStats,
    history,
    currentDatasets,
    watermark,
  ] = await Promise.all([
    getDatasetSchedulerStatusAsync(),
    getGmailConnectionStatus(),
    getLocalDatasetDriveFolderStatistics(setup),
    listSyncHistory(30),
    listCurrentDatasetFiles().catch(() => []),
    readSyncWatermark(),
  ]);

  const folderByName = new Map(
    folderStats.map((item) => [item.datasetName, item])
  );
  const currentByName = new Map(
    currentDatasets.map((item) => [item.datasetName, item])
  );

  const rows: DatasetConfigOverviewRow[] = DATASET_SYNC_NAMES.map(
    (datasetName) => {
      const config = setup?.datasets?.[datasetName];
      const folderConfig = setup
        ? getDatasetDriveFolderConfig(setup, datasetName)
        : null;
      const folderStat = folderByName.get(datasetName);

      let folderId = folderStat?.folderId || folderConfig?.folderId || "";
      try {
        if (setup) {
          folderId = resolveDriveFolderIdForDataset(setup, datasetName);
        }
      } catch {
        // keep partial id
      }

      const relatedSchedules = (scheduler.schedules ?? []).filter((schedule) =>
        schedule.datasetNames.includes(datasetName)
      );
      const activeSchedules = relatedSchedules.filter(
        (schedule) => schedule.statusLabel === "Active"
      );
      const nextSyncAt =
        activeSchedules
          .map((schedule) => schedule.nextRunAt)
          .filter((value): value is string => Boolean(value))
          .sort()[0] ?? null;

      const lastHistory = history.find((entry) => entry.dataset === datasetName);
      const lastScheduleRun = relatedSchedules
        .filter((schedule) => schedule.lastRunAt)
        .sort((a, b) =>
          String(b.lastRunAt).localeCompare(String(a.lastRunAt))
        )[0];

      const lastSyncAt =
        lastHistory?.syncTime ?? lastScheduleRun?.lastRunAt ?? null;
      const lastSyncStatus =
        lastHistory?.status ?? lastScheduleRun?.lastRunStatus ?? null;

      const keywords = (config?.keywords ?? []).map((keyword) => ({
        value: keyword.value,
        enabled: keyword.enabled,
        priority: keyword.priority,
        matchMode: keyword.matchMode,
      }));

      const hasKeywords = keywords.some((keyword) => keyword.enabled);

      const { status, statusDetail } = deriveStatus({
        configured: Boolean(setup),
        enabled: config?.enabled !== false,
        hasFolder: Boolean(folderId && folderId !== "—"),
        hasSendersOrKeywords: hasKeywords,
        schedulesPaused:
          relatedSchedules.length > 0 && activeSchedules.length === 0,
        hasActiveSchedule: activeSchedules.length > 0,
        lastSyncStatus,
        gmailConnected: Boolean(gmail.connected),
      });

      const current = currentByName.get(datasetName);

      return {
        datasetName,
        enabled: config?.enabled !== false,
        gmailAccount: setup?.gmailAddress ?? null,
        gmailConnected: Boolean(gmail.connected),
        gmailConnectedEmail: gmail.email ?? null,
        keywords,
        driveFolder: {
          name:
            folderStat?.folderName ||
            folderConfig?.folderName ||
            "—",
          id: folderId || "—",
          url: folderConfig?.folderUrl || "",
          openUrl: driveOpenUrl(folderId, folderConfig?.folderUrl),
        },
        schedules: relatedSchedules.map((schedule) => ({
          id: schedule.id,
          name: schedule.name,
          timeLabel: schedule.timeLabel,
          frequency: schedule.frequency,
          statusLabel: schedule.statusLabel,
          nextRunAt: schedule.nextRunAt,
          lastRunAt: schedule.lastRunAt,
        })),
        lastSyncAt,
        lastSyncStatus,
        nextSyncAt,
        status,
        statusDetail,
        currentFileName: current?.fileName ?? null,
        currentFileUpdatedAt: current
          ? new Date(current.mtimeMs).toISOString()
          : null,
      };
    }
  );

  return {
    configured: Boolean(setup),
    checkedAt: new Date().toISOString(),
    lastSuccessfulSyncAt: watermark.lastSuccessfulSyncAt,
    healthyCount: rows.filter((row) => row.status === "Healthy").length,
    attentionCount: rows.filter((row) =>
      ["Attention", "Error"].includes(row.status)
    ).length,
    pausedCount: rows.filter((row) =>
      ["Paused", "Disabled"].includes(row.status)
    ).length,
    rows,
  };
}
