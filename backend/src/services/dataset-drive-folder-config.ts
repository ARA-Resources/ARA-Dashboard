/**
 * Stage 20: local Drive folder config helpers — no Google API.
 * Matches Next src/services/drive/folder.ts subset.
 */
import type {
  DatasetDriveFolderConfig,
  DatasetSetupConfig,
} from "../types/dataset-setup.js";
import type { DatasetSyncName } from "../types/dataset-sync.js";

export function parseDriveFolderIdFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch?.[1]) return folderMatch[1];
  const idMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idMatch?.[1]) return idMatch[1];
  return null;
}

export function resolveFolderIdFromConfig(
  folder: DatasetDriveFolderConfig | null | undefined,
  datasetName?: string
): string {
  const direct = folder?.folderId?.trim();
  if (direct && direct !== "pending-picker-folder-id") {
    return direct;
  }

  const fromUrl = folder?.folderUrl
    ? parseDriveFolderIdFromUrl(folder.folderUrl)
    : null;
  if (fromUrl) return fromUrl;

  const label = datasetName ? ` for ${datasetName}` : "";
  throw new Error(
    `Google Drive folder is not configured${label}. Set Folder ID or Folder URL in Dataset setup.`
  );
}

export function resolveDriveFolderIdForDataset(
  setup: DatasetSetupConfig,
  datasetName: DatasetSyncName | string
): string {
  const config = setup.datasets?.[datasetName as DatasetSyncName];
  if (config?.driveFolder) {
    return resolveFolderIdFromConfig(config.driveFolder, datasetName);
  }

  const legacy: DatasetDriveFolderConfig = {
    mode: setup.driveFolderMode ?? "folder_id",
    folderName: setup.driveFolderName ?? "",
    folderId: setup.driveFolderId ?? "",
    folderUrl: setup.driveFolderUrl ?? "",
  };
  return resolveFolderIdFromConfig(legacy, datasetName);
}

export function getDatasetDriveFolderConfig(
  setup: DatasetSetupConfig,
  datasetName: DatasetSyncName | string
): DatasetDriveFolderConfig | null {
  return setup.datasets?.[datasetName as DatasetSyncName]?.driveFolder ?? null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
