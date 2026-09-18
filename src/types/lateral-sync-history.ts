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
  /** Count of recoverable candidates skipped before this run's real outcome. 0 when none. */
  skippedCount?: number;
  /** Detail per skipped candidate (filename, messageId, error) — null when none. */
  skippedDetail?: Array<{
    attachmentName: string;
    messageId: string;
    receivedAt?: string;
    status?: string;
    error: string;
  }> | null;
}
