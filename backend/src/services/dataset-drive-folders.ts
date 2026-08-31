/**
 * Stage 20: local Drive folder stats — matches Next getLocalDatasetDriveFolderStatistics.
 * Does NOT call Google Drive.
 */
import { readDatasetSetup } from "./dataset-setup.js";
import {
  formatBytes,
  getDatasetDriveFolderConfig,
  resolveDriveFolderIdForDataset,
} from "./dataset-drive-folder-config.js";
import { readDriveMetaStore } from "./dataset-drive-metadata.js";
import { DATASET_SYNC_NAMES } from "../types/dataset-sync.js";
import type { DatasetSetupConfig } from "../types/dataset-setup.js";
import type { DatasetSyncName } from "../types/dataset-sync.js";
import type {
  DatasetDriveFolderStats,
  DatasetDriveFoldersGetResponse,
} from "../types/dataset-drive-folders.js";

function buildBaseRow(
  datasetName: DatasetSyncName,
  config: DatasetSetupConfig,
  meta:
    | Awaited<ReturnType<typeof readDriveMetaStore>>["byDataset"][string]
    | undefined
): DatasetDriveFolderStats {
  const folder = getDatasetDriveFolderConfig(config, datasetName);
  let folderId = "";
  try {
    folderId = resolveDriveFolderIdForDataset(config, datasetName);
  } catch {
    folderId = folder?.folderId?.trim() || "";
  }

  return {
    datasetName,
    folderName: folder?.folderName?.trim() || "—",
    folderId: folderId || "—",
    folderUrl: folder?.folderUrl?.trim() || "",
    mode: folder?.mode ?? "folder_id",
    lastUpload: meta?.uploadTime ?? null,
    lastUploadFileName: meta?.fileName ?? null,
    totalFiles: meta ? 1 : 0,
    storageUsedBytes: meta?.fileSize ?? 0,
    storageUsedLabel: formatBytes(meta?.fileSize ?? 0),
  };
}

export async function getLocalDatasetDriveFolderStatistics(
  setup?: DatasetSetupConfig | null
): Promise<DatasetDriveFolderStats[]> {
  const config = setup ?? (await readDatasetSetup());
  if (!config) return [];

  const store = await readDriveMetaStore();
  return DATASET_SYNC_NAMES.map((datasetName) => {
    const base = buildBaseRow(
      datasetName,
      config,
      store.byDataset[datasetName]
    );
    if (!base.folderId || base.folderId === "—") {
      return { ...base, error: "Folder not configured" };
    }
    return base;
  });
}

/** Read-only GET response — default non-live path only. */
export async function getDatasetDriveFoldersResponse(options?: {
  live?: boolean;
}): Promise<DatasetDriveFoldersGetResponse> {
  const live = options?.live === true;
  const setup = await readDatasetSetup();
  const folders = live
    ? []
    : await getLocalDatasetDriveFolderStatistics(setup);
  return {
    configured: Boolean(setup),
    live,
    folders,
  };
}
