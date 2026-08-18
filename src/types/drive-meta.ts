import type { DatasetSyncName } from "@/types/dataset-sync";

export interface DatasetDriveFileMeta {
  datasetName: DatasetSyncName | string;
  driveFileId: string;
  fileName: string;
  uploadTime: string;
  fileSize: number;
  versionNumber: number;
  webViewLink?: string | null;
  folderId: string;
}

export interface DatasetDriveFolderStats {
  datasetName: DatasetSyncName;
  folderName: string;
  folderId: string;
  folderUrl: string;
  mode: string;
  lastUpload: string | null;
  lastUploadFileName: string | null;
  totalFiles: number;
  storageUsedBytes: number;
  storageUsedLabel: string;
  error?: string;
}

export interface DatasetDriveMetaStore {
  updatedAt: string;
  byDataset: Record<string, DatasetDriveFileMeta>;
}
