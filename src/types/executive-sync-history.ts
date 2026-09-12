/** Mirrors `types/lateral-sync-history.ts` structurally — own table, own store. */

export type ExecutiveSyncHistoryResult = "Success" | "Failed";

/** Safe Executive sync history row — never includes OAuth tokens or credentials. */
export interface ExecutiveSyncHistoryEntry {
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
  result: ExecutiveSyncHistoryResult;
  error: string | null;
  trigger: "scheduler" | "manual";
  durationMs: number;
}
