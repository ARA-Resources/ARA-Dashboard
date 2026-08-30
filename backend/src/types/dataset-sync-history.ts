export type SyncHistoryStatus =
  | "success"
  | "failed"
  | "partial"
  | "skipped"
  | "updated";

export type SyncHistoryTrigger = "scheduler" | "manual" | "api";

export type SyncHistoryEntry = {
  id: string;
  runId: string;
  dataset: string;
  syncTime: string;
  downloadedFrom: string;
  uploadedTo: string;
  fileName: string;
  durationMs: number;
  status: SyncHistoryStatus;
  errors: string | null;
  trigger: SyncHistoryTrigger;
  /** Day key for JSONL log download, e.g. 2026-08-08 */
  logDay: string;
  itemStatus?: string;
  driveFileId?: string | null;
  messageId?: string | null;
  attachmentId?: string | null;
  originalName?: string | null;
  fileSize?: number | null;
  checksumSha256?: string | null;
};

export type SyncHistoryListResponse = {
  entries: SyncHistoryEntry[];
  count: number;
};

export type SyncHistoryStore = {
  version: 1;
  entries: SyncHistoryEntry[];
};
