import type { DatasetSyncName } from "@/types/dataset-sync";
import type { ScheduleFrequency } from "@/types/dataset-schedule";

export type DatasetAutomationHealthStatus =
  | "Healthy"
  | "Attention"
  | "Paused"
  | "Disabled"
  | "Not configured"
  | "Error";

export interface DatasetConfigOverviewRow {
  datasetName: DatasetSyncName;
  enabled: boolean;
  gmailAccount: string | null;
  gmailConnected: boolean;
  gmailConnectedEmail: string | null;
  keywords: Array<{
    value: string;
    enabled: boolean;
    priority: number;
    matchMode: string;
  }>;
  driveFolder: {
    name: string;
    id: string;
    url: string;
    openUrl: string | null;
  };
  schedules: Array<{
    id: string;
    name: string;
    timeLabel: string;
    frequency: ScheduleFrequency;
    statusLabel: string;
    nextRunAt: string | null;
    lastRunAt: string | null;
  }>;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  nextSyncAt: string | null;
  status: DatasetAutomationHealthStatus;
  statusDetail: string;
  currentFileName: string | null;
  currentFileUpdatedAt: string | null;
}

export interface DatasetConfigurationOverview {
  configured: boolean;
  checkedAt: string;
  /** Global Gmail search cursor — next scheduled run searches after this */
  lastSuccessfulSyncAt: string | null;
  healthyCount: number;
  attentionCount: number;
  pausedCount: number;
  rows: DatasetConfigOverviewRow[];
}
