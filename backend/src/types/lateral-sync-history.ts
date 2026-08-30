export type LateralSyncHistoryResult = "Success" | "Failed";
export type LateralSyncHistoryTrigger = "scheduler" | "manual";

export interface LateralSyncHistoryEntry {
  id: string;
  syncTime: string;
  sourceEmail: string;
  originalFilename: string;
  googleDriveFileId: string;
  rowsImported: number;
  newCount: number;
  activeCount: number;
  reopenCount: number;
  closedCount: number;
  result: LateralSyncHistoryResult;
  error: string | null;
  trigger: LateralSyncHistoryTrigger;
  durationMs: number;
}

export interface LateralSyncHistoryResponse {
  datasetName: "Lateral";
  entries: LateralSyncHistoryEntry[];
  count: number;
}
