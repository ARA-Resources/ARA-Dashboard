import type { drive_v3 } from "googleapis";
import {
  formatBytes,
  getDatasetDriveFolderConfig,
  resolveDriveFolderIdForDataset,
} from "@/services/drive/folder";
import { readDriveMetaStore } from "@/services/drive/metadata-store";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import { readDatasetSetup } from "@/services/dataset/secure-store";
import { DATASET_SYNC_NAMES, type DatasetSyncName } from "@/types/dataset-sync";
import type { DatasetSetupConfig } from "@/types/dataset-setup";
import type { DatasetDriveFolderStats } from "@/types/drive-meta";

export type { DatasetDriveFolderStats };

const LIVE_CACHE_TTL_MS = 2 * 60 * 1000;

type LiveCacheEntry = {
  at: number;
  rows: DatasetDriveFolderStats[];
};

let liveCache: LiveCacheEntry | null = null;

export function invalidateDriveFolderStatsCache() {
  liveCache = null;
}

async function listFolderStats(
  drive: drive_v3.Drive,
  folderId: string
): Promise<{ totalFiles: number; storageUsedBytes: number }> {
  let pageToken: string | undefined;
  let totalFiles = 0;
  let storageUsedBytes = 0;

  do {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken, files(id, size)",
      pageSize: 200,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const files = response.data.files ?? [];
    totalFiles += files.length;
    for (const file of files) {
      storageUsedBytes += Number(file.size ?? 0);
    }
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return { totalFiles, storageUsedBytes };
}

function buildBaseRow(
  datasetName: DatasetSyncName,
  config: DatasetSetupConfig,
  meta: Awaited<ReturnType<typeof readDriveMetaStore>>["byDataset"][string] | undefined
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

/**
 * Fast path: setup + local Drive upload metadata only (no Google API).
 * Used for page loads and configuration overview.
 */
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

async function fetchLiveFolderStatistics(
  config: DatasetSetupConfig
): Promise<DatasetDriveFolderStats[]> {
  let drive: drive_v3.Drive | null = null;
  try {
    const client = await getAuthorizedGmailClient();
    drive = client.drive;
  } catch {
    drive = null;
  }

  const store = await readDriveMetaStore();

  const rows = await Promise.all(
    DATASET_SYNC_NAMES.map(async (datasetName) => {
      const base = buildBaseRow(
        datasetName,
        config,
        store.byDataset[datasetName]
      );
      const folderId =
        base.folderId && base.folderId !== "—" ? base.folderId : "";

      if (!drive || !folderId) {
        return {
          ...base,
          error: !folderId
            ? "Folder not configured"
            : "Drive not connected — showing local upload metadata only",
        };
      }

      try {
        const [folderMeta, listed] = await Promise.all([
          drive.files.get({
            fileId: folderId,
            fields: "id, name",
            supportsAllDrives: true,
          }),
          listFolderStats(drive, folderId),
        ]);
        return {
          ...base,
          folderName:
            folderMeta.data.name?.trim() ||
            base.folderName,
          folderId,
          totalFiles: listed.totalFiles,
          storageUsedBytes: listed.storageUsedBytes,
          storageUsedLabel: formatBytes(listed.storageUsedBytes),
        };
      } catch (error) {
        return {
          ...base,
          folderId,
          error:
            error instanceof Error
              ? error.message
              : "Unable to read Drive folder stats",
        };
      }
    })
  );

  return rows;
}

/**
 * Drive folder stats for Dataset Manager / APIs.
 * - live=false (default): local metadata only — fast page loads
 * - live=true: Google Drive list (cached ~2 min); use for Refresh
 */
export async function getDatasetDriveFolderStatistics(
  setup?: DatasetSetupConfig | null,
  options?: { live?: boolean }
): Promise<DatasetDriveFolderStats[]> {
  const config = setup ?? (await readDatasetSetup());
  if (!config) return [];

  if (!options?.live) {
    return getLocalDatasetDriveFolderStatistics(config);
  }

  if (liveCache && Date.now() - liveCache.at < LIVE_CACHE_TTL_MS) {
    return liveCache.rows;
  }

  const rows = await fetchLiveFolderStatistics(config);
  liveCache = { at: Date.now(), rows };
  return rows;
}
