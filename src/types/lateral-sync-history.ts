export type LateralSyncHistoryResult = "Success" | "Failed";

/** Safe Lateral sync history row — never includes OAuth tokens or credentials. */
export interface LateralSyncHistoryEntry {
  id: string;
  /** ISO timestamp */
  syncTime: string;
  /** Source email / message display info (not tokens) */
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
  trigger: "scheduler" | "manual";
  durationMs: number;
}
