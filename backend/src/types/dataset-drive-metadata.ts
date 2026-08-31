import type { DatasetSyncName } from "./dataset-sync.js";

export type DatasetDriveFileMeta = {
  datasetName: DatasetSyncName | string;
  driveFileId: string;
  fileName: string;
  uploadTime: string;
  fileSize: number;
  versionNumber: number;
  webViewLink?: string | null;
  folderId: string;
};

export type DatasetDriveMetaStore = {
  updatedAt: string;
  byDataset: Record<string, DatasetDriveFileMeta>;
};
