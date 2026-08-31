import type { DatasetSyncName } from "./dataset-sync.js";

export type DatasetDriveFolderStats = {
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
};

export type DatasetDriveFoldersGetResponse = {
  configured: boolean;
  live: boolean;
  folders: DatasetDriveFolderStats[];
};
