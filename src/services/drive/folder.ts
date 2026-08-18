import type {
  DatasetDriveFolderConfig,
  DatasetSetupConfig,
} from "@/types/dataset-setup";
import type { DatasetSyncName } from "@/types/dataset-sync";
import { DATASET_SYNC_NAMES } from "@/types/dataset-sync";

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

/**
 * Resolve the mapped Google Drive folder ID for one dataset.
 * Never falls back to another dataset's folder.
 */
export function resolveDriveFolderIdForDataset(
  setup: DatasetSetupConfig,
  datasetName: DatasetSyncName | string
): string {
  const config = setup.datasets?.[datasetName as DatasetSyncName];
  if (config?.driveFolder) {
    return resolveFolderIdFromConfig(config.driveFolder, datasetName);
  }

  // Legacy single-folder fallback (pre per-dataset mapping)
  const legacy: DatasetDriveFolderConfig = {
    mode: setup.driveFolderMode ?? "folder_id",
    folderName: setup.driveFolderName ?? "",
    folderId: setup.driveFolderId ?? "",
    folderUrl: setup.driveFolderUrl ?? "",
  };
  return resolveFolderIdFromConfig(legacy, datasetName);
}

/** @deprecated Use resolveDriveFolderIdForDataset */
export function resolveDriveFolderId(setup: DatasetSetupConfig): string {
  for (const name of DATASET_SYNC_NAMES) {
    try {
      return resolveDriveFolderIdForDataset(setup, name);
    } catch {
      // try next
    }
  }
  throw new Error(
    "Google Drive folder is not configured. Set a Folder ID or Folder URL per dataset in Dataset setup."
  );
}

export function getDatasetDriveFolderConfig(
  setup: DatasetSetupConfig,
  datasetName: DatasetSyncName | string
): DatasetDriveFolderConfig | null {
  return setup.datasets?.[datasetName as DatasetSyncName]?.driveFolder ?? null;
}

export function excelMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsm")) {
    return "application/vnd.ms-excel.sheet.macroEnabled.12";
  }
  if (lower.endsWith(".xls") && !lower.endsWith(".xlsx")) {
    return "application/vnd.ms-excel";
  }
  return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
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

export interface DriveFolderListItem {
  id: string;
  name: string;
  modifiedTime: string | null;
  webViewLink: string | null;
}

/**
 * List Google Drive folders for picker UI (shared Dataset connection).
 * Does not hardcode folder IDs — returns live Drive results.
 */
export async function listDriveFolders(options?: {
  parentId?: string;
  query?: string;
  pageSize?: number;
}): Promise<DriveFolderListItem[]> {
  const { getAuthorizedGmailClient } = await import("@/services/gmail/oauth");
  const { drive } = await getAuthorizedGmailClient();
  const parentId = options?.parentId?.trim() || "root";
  const query = options?.query?.trim();
  const pageSize = Math.min(100, Math.max(1, options?.pageSize ?? 50));

  const clauses = [
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
  ];
  if (query) {
    const escaped = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    clauses.push(`name contains '${escaped}'`);
  } else if (parentId !== "root") {
    clauses.push(`'${parentId}' in parents`);
  } else {
    clauses.push(`'root' in parents`);
  }

  const res = await drive.files.list({
    q: clauses.join(" and "),
    fields: "files(id,name,modifiedTime,webViewLink)",
    pageSize,
    orderBy: "name_natural",
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    corpora: "allDrives",
  });

  return (res.data.files ?? [])
    .filter((file) => Boolean(file.id && file.name))
    .map((file) => ({
      id: file.id as string,
      name: file.name as string,
      modifiedTime: file.modifiedTime ?? null,
      webViewLink: file.webViewLink ?? null,
    }));
}
