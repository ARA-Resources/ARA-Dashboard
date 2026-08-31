import { DATASET_SYNC_NAMES } from "../types/dataset-sync.js";
import type {
  DatasetFileType,
  DatasetSearchConfig,
  DatasetSearchConfigMap,
  DatasetSetupConfig,
  DriveFolderInputMode,
  FileReplacePolicy,
  SyncFrequency,
} from "../types/dataset-setup.js";
import {
  DEFAULT_FILE_TYPES,
  DEFAULT_SYNC_TIME,
  KEYWORD_MATCH_MODES,
  createEmptyDatasetsMap,
  getEnabledKeywords,
  normalizeDriveFolderConfig,
  normalizeKeywords,
} from "../types/dataset-setup.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const FILE_TYPES = new Set<DatasetFileType>(["xlsx", "xlsm", "xls"]);

function parseDriveFolderIdFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch?.[1]) return folderMatch[1];
  const idMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idMatch?.[1]) return idMatch[1];
  return null;
}

function cleanEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

function isReplacePolicy(value: unknown): value is FileReplacePolicy {
  return (
    value === "replace" || value === "keep_old" || value === "version_history"
  );
}

function isSyncFrequency(value: unknown): boolean {
  return (
    value === "hourly" ||
    value === "daily" ||
    value === "weekdays" ||
    value === "custom" ||
    value === "custom_cron"
  );
}

function isFolderMode(value: unknown): value is DriveFolderInputMode {
  return value === "picker" || value === "folder_id" || value === "folder_url";
}

function validateDatasetSearchConfig(
  name: string,
  raw: unknown
): { ok: true; config: DatasetSearchConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: `${name}: missing search configuration.` };
  }
  const input = raw as Record<string, unknown>;
  const enabled = input.enabled !== false;

  const keywords = normalizeKeywords(
    input.keywords,
    input.searchKeywords,
    input.attachmentKeywords
  );

  for (const keyword of keywords) {
    if (!keyword.value.trim()) {
      return { ok: false, error: `${name}: keyword value cannot be empty.` };
    }
    if (!KEYWORD_MATCH_MODES.includes(keyword.matchMode)) {
      return {
        ok: false,
        error: `${name}: invalid match mode for "${keyword.value}".`,
      };
    }
    if (keyword.matchMode === "regex") {
      try {
        void new RegExp(keyword.value, "i");
      } catch {
        return {
          ok: false,
          error: `${name}: invalid regex keyword "${keyword.value}".`,
        };
      }
    }
  }

  const fileTypesRaw = Array.isArray(input.fileTypes) ? input.fileTypes : [];
  const fileTypes = fileTypesRaw.filter(
    (item): item is DatasetFileType =>
      typeof item === "string" && FILE_TYPES.has(item as DatasetFileType)
  );

  const driveFolder = normalizeDriveFolderConfig(
    input.driveFolder,
    undefined,
    name
  );

  const configBase: DatasetSearchConfig = {
    enabled,
    keywords,
    fileTypes: fileTypes.length > 0 ? fileTypes : [...DEFAULT_FILE_TYPES],
    driveFolder,
  };

  if (!enabled) {
    return { ok: true, config: { ...configBase, enabled: false } };
  }

  if (configBase.fileTypes.length === 0) {
    return {
      ok: false,
      error: `${name}: select at least one supported file type.`,
    };
  }

  const enabledKeywords = getEnabledKeywords(configBase);
  if (enabledKeywords.length === 0) {
    return {
      ok: false,
      error: `${name}: add and enable at least one keyword (or disable this dataset).`,
    };
  }

  if (!isFolderMode(driveFolder.mode)) {
    return {
      ok: false,
      error: `${name}: select Folder Picker, Folder ID, or Folder URL.`,
    };
  }

  if (driveFolder.mode === "folder_id" && !driveFolder.folderId) {
    return {
      ok: false,
      error: `${name}: enter the Google Drive Folder ID.`,
    };
  }
  if (driveFolder.mode === "folder_url") {
    if (!driveFolder.folderUrl) {
      return {
        ok: false,
        error: `${name}: enter the Google Drive Folder URL.`,
      };
    }
    if (
      !parseDriveFolderIdFromUrl(driveFolder.folderUrl) &&
      !driveFolder.folderId
    ) {
      return {
        ok: false,
        error: `${name}: Folder URL must include a Drive folder ID.`,
      };
    }
  }
  if (
    driveFolder.mode === "picker" &&
    !driveFolder.folderName &&
    !driveFolder.folderId
  ) {
    return {
      ok: false,
      error: `${name}: pick a Drive folder (name or ID).`,
    };
  }
  if (
    driveFolder.folderId === "pending-picker-folder-id" &&
    !driveFolder.folderUrl
  ) {
    return {
      ok: false,
      error: `${name}: replace the placeholder Folder ID with a real Drive folder ID.`,
    };
  }

  return { ok: true, config: { ...configBase, enabled: true } };
}

export function validateDatasetSetupInput(
  body: unknown
): { ok: true; config: DatasetSetupConfig } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Invalid setup payload." };
  }

  const input = body as Record<string, unknown>;

  const gmailAddress = cleanEmail(input.gmailAddress);
  if (!gmailAddress) {
    return { ok: false, error: "Enter a valid Gmail address to monitor." };
  }

  const datasetsInput =
    input.datasets && typeof input.datasets === "object"
      ? (input.datasets as Record<string, unknown>)
      : {};

  const datasets = createEmptyDatasetsMap();
  let enabledCount = 0;

  for (const name of DATASET_SYNC_NAMES) {
    const result = validateDatasetSearchConfig(name, datasetsInput[name]);
    if (!result.ok) return result;
    datasets[name] = result.config;
    if (result.config.enabled) enabledCount += 1;
  }

  if (enabledCount === 0) {
    return {
      ok: false,
      error: "Enable at least one dataset (Lateral, Executive, or Consulting).",
    };
  }

  if (!isReplacePolicy(input.fileReplacePolicy)) {
    return { ok: false, error: "Select how files should be replaced." };
  }

  const driveAccountEmail = cleanEmail(input.driveAccountEmail);
  if (!driveAccountEmail) {
    return {
      ok: false,
      error: "Enter the Google Drive account that should receive files.",
    };
  }

  if (
    input.driveAuthStatus !== "pending" &&
    input.driveAuthStatus !== "authenticated" &&
    input.driveAuthStatus !== "expired"
  ) {
    return { ok: false, error: "Drive authentication status is invalid." };
  }

  if (input.driveAuthStatus !== "authenticated") {
    return {
      ok: false,
      error: "Authenticate the Google Drive account before saving setup.",
    };
  }

  if (!isSyncFrequency(input.syncFrequency)) {
    return { ok: false, error: "Select a synchronization frequency." };
  }

  const syncTime =
    typeof input.syncTime === "string" && input.syncTime.trim()
      ? input.syncTime.trim()
      : DEFAULT_SYNC_TIME;

  const syncFrequencyRaw = input.syncFrequency;
  const syncFrequency: SyncFrequency =
    syncFrequencyRaw === "custom_cron"
      ? "custom"
      : (syncFrequencyRaw as SyncFrequency);

  const customDays = Array.isArray(input.customDays)
    ? input.customDays
        .map((item) => Number(item))
        .filter((day) => Number.isFinite(day) && day >= 0 && day <= 6)
        .map((day) => Math.floor(day))
    : [1, 2, 3, 4, 5];
  const customTimes = Array.isArray(input.customTimes)
    ? input.customTimes
        .filter(
          (item): item is string =>
            typeof item === "string" && Boolean(item.trim())
        )
        .map((item) => item.trim())
    : [syncTime];

  if (syncFrequency === "custom") {
    if (customDays.length === 0) {
      return {
        ok: false,
        error: "Select at least one day for the custom schedule.",
      };
    }
    if (customTimes.length === 0) {
      return {
        ok: false,
        error: "Add at least one time for the custom schedule.",
      };
    }
  }

  const customCron =
    typeof input.customCron === "string" ? input.customCron.trim() : "";

  const notifyOnFailure =
    typeof input.notifyOnFailure === "boolean" ? input.notifyOnFailure : true;
  const notifyOnSuccess =
    typeof input.notifyOnSuccess === "boolean" ? input.notifyOnSuccess : false;
  const alertEmailRaw =
    typeof input.alertEmail === "string" ? input.alertEmail.trim() : "";
  const alertEmail = alertEmailRaw ? cleanEmail(alertEmailRaw) : "";
  if (alertEmailRaw && !alertEmail) {
    return { ok: false, error: "Enter a valid alert email address." };
  }

  const config: DatasetSetupConfig = {
    version: 1,
    updatedAt: new Date().toISOString(),
    gmailAddress,
    datasets: datasets as DatasetSearchConfigMap,
    fileReplacePolicy: input.fileReplacePolicy,
    driveAccountEmail,
    driveAuthStatus: input.driveAuthStatus,
    syncFrequency,
    syncTime: customTimes[0] ?? syncTime,
    customCron: customCron || "0 7 * * *",
    customDays: Array.from(new Set(customDays)).sort((a, b) => a - b),
    customTimes: Array.from(new Set(customTimes)),
    notifyOnFailure,
    notifyOnSuccess,
    alertEmail: alertEmail || "",
  };

  return { ok: true, config };
}
