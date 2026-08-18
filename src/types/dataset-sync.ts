export type SyncDownloadStatus =
  | "downloaded"
  | "validated"
  | "stored_temp"
  | "promoted"
  | "uploaded_drive"
  | "upload_failed"
  | "skipped_duplicate"
  | "skipped_superseded"
  | "validation_failed"
  | "download_failed"
  | "unmapped";

export interface DatasetSyncItemResult {
  datasetName: string | null;
  messageId: string;
  attachmentId: string;
  originalName: string;
  renamedFile: string | null;
  tempPath: string | null;
  currentPath: string | null;
  status: SyncDownloadStatus;
  error?: string;
  receivedAt: string;
  /** Gmail From header for sender statistics */
  sender?: string | null;
  /** Keyword that identified this dataset */
  matchedKeyword?: string | null;
  matchedIn?: "subject" | "body" | "attachment" | null;
  matchMode?: string | null;
  driveFileId?: string | null;
  driveUploadTime?: string | null;
  driveFileSize?: number | null;
  driveVersionNumber?: number | null;
  /** SHA-256 of attachment bytes after download */
  checksumSha256?: string | null;
  fileSize?: number | null;
}

export interface DatasetSyncLogEntry {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
  details?: Record<string, unknown>;
}

export interface DatasetSyncResult {
  ranAt: string;
  query: string;
  connectedEmail: string | null;
  items: DatasetSyncItemResult[];
  logs: DatasetSyncLogEntry[];
  downloadedCount: number;
  validatedCount: number;
  uploadedCount: number;
  failedCount: number;
  preservedCurrentCount: number;
}

export const DATASET_SYNC_NAMES = ["Lateral", "Executive", "Consulting"] as const;
export type DatasetSyncName = (typeof DATASET_SYNC_NAMES)[number];
