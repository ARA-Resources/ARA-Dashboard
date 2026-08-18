import { DATASET_SYNC_NAMES, type DatasetSyncName } from "@/types/dataset-sync";

export type FileReplacePolicy = "replace" | "keep_old" | "version_history";

export type SyncFrequency =
  | "hourly"
  | "daily"
  | "weekdays"
  | "custom";

export type DriveFolderInputMode = "picker" | "folder_id" | "folder_url";

export type DriveAuthStatus = "pending" | "authenticated" | "expired";

export type DatasetFileType = "xlsx" | "xlsm" | "xls";

export type KeywordMatchMode =
  | "contains"
  | "exact"
  | "starts_with"
  | "ends_with"
  | "regex";

export const KEYWORD_MATCH_MODES: KeywordMatchMode[] = [
  "contains",
  "exact",
  "starts_with",
  "ends_with",
  "regex",
];

export const KEYWORD_MATCH_MODE_LABELS: Record<KeywordMatchMode, string> = {
  contains: "Contains",
  exact: "Exact Match",
  starts_with: "Starts With",
  ends_with: "Ends With",
  regex: "Regex",
};

/**
 * Search keyword for attachment name, subject, and body.
 * Any enabled keyword match assigns the email to this dataset.
 */
export interface DatasetKeywordConfig {
  value: string;
  enabled: boolean;
  /** Lower number = higher priority when multiple keywords match */
  priority: number;
  matchMode: KeywordMatchMode;
}

/**
 * Independent keyword + Drive configuration for one dataset.
 * Gmail scan is date-based (all inbox Excel mail on the selected day);
 * dataset assignment is by keywords only — not by sender.
 */
export interface DatasetSearchConfig {
  enabled: boolean;
  /** Keywords matched against attachment name, subject, then body */
  keywords: DatasetKeywordConfig[];
  /**
   * @deprecated Prefer `keywords`
   */
  searchKeywords?: string[];
  /**
   * @deprecated Prefer `keywords`
   */
  attachmentKeywords?: string[];
  /** Allowed extensions */
  fileTypes: DatasetFileType[];
  /** Dedicated Google Drive destination for this dataset */
  driveFolder: DatasetDriveFolderConfig;
}

/**
 * Per-dataset Google Drive folder mapping.
 * Files for this dataset upload only here — never to another dataset's folder.
 */
export interface DatasetDriveFolderConfig {
  mode: DriveFolderInputMode;
  folderName: string;
  folderId: string;
  folderUrl: string;
}

export function createEmptyDriveFolderConfig(
  seedName?: string
): DatasetDriveFolderConfig {
  return {
    mode: "folder_id",
    folderName: seedName ? `ATCI ${seedName}` : "",
    folderId: "",
    folderUrl: "",
  };
}

export function normalizeDriveFolderConfig(
  raw: unknown,
  legacy?: {
    mode?: unknown;
    folderName?: unknown;
    folderId?: unknown;
    folderUrl?: unknown;
  },
  seedName?: string
): DatasetDriveFolderConfig {
  const empty = createEmptyDriveFolderConfig(seedName);
  const source =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : ({} as Record<string, unknown>);

  const mode =
    source.mode === "picker" ||
    source.mode === "folder_id" ||
    source.mode === "folder_url"
      ? source.mode
      : legacy?.mode === "picker" ||
          legacy?.mode === "folder_id" ||
          legacy?.mode === "folder_url"
        ? legacy.mode
        : empty.mode;

  const folderName =
    typeof source.folderName === "string" && source.folderName.trim()
      ? source.folderName.trim()
      : typeof legacy?.folderName === "string" && legacy.folderName.trim()
        ? legacy.folderName.trim()
        : empty.folderName;

  const folderId =
    typeof source.folderId === "string" ? source.folderId.trim() : "";
  const legacyId =
    typeof legacy?.folderId === "string" ? legacy.folderId.trim() : "";

  const folderUrl =
    typeof source.folderUrl === "string" ? source.folderUrl.trim() : "";
  const legacyUrl =
    typeof legacy?.folderUrl === "string" ? legacy.folderUrl.trim() : "";

  return {
    mode,
    folderName,
    folderId: folderId || legacyId,
    folderUrl: folderUrl || legacyUrl,
  };
}

export type DatasetSearchConfigMap = Record<DatasetSyncName, DatasetSearchConfig>;

/**
 * Dataset automation setup collected by the wizard.
 * Editable anytime from Dataset Manager → Configuration.
 */
export interface DatasetSetupConfig {
  version: 1;
  updatedAt: string;

  /** Shared mailbox to monitor */
  gmailAddress: string;

  /** Per-dataset keyword + Drive configs */
  datasets: DatasetSearchConfigMap;

  fileReplacePolicy: FileReplacePolicy;

  driveAccountEmail: string;
  driveAuthStatus: DriveAuthStatus;

  /**
   * @deprecated Prefer datasets[*].driveFolder — kept for migration
   */
  driveFolderMode?: DriveFolderInputMode;
  /** @deprecated */
  driveFolderName?: string;
  /** @deprecated */
  driveFolderId?: string;
  /** @deprecated */
  driveFolderUrl?: string;

  syncFrequency: SyncFrequency;
  syncTime: string;
  /**
   * @deprecated Prefer customDays / customTimes — kept for migration
   */
  customCron: string;
  /** Used when syncFrequency is custom */
  customDays?: number[];
  /** Used when syncFrequency is custom */
  customTimes?: string[];

  notifyOnFailure: boolean;
  notifyOnSuccess: boolean;
  alertEmail: string;
}

export interface DatasetSetupPublicView {
  configured: boolean;
  updatedAt: string | null;
  setup: Omit<DatasetSetupConfig, never> | null;
}

export const DEFAULT_SYNC_TIME = "07:00";

export const DEFAULT_FILE_TYPES: DatasetFileType[] = ["xlsx", "xlsm", "xls"];

/** Default keyword libraries when creating a new setup */
export const DEFAULT_DATASET_KEYWORDS: Record<DatasetSyncName, string[]> = {
  Lateral: ["ATCI Lateral", "MasterSheet", "DS AI", "Lateral"],
  Executive: ["Exec", "Executive", "Job Reqs", "Leadership"],
  Consulting: ["Latest Demand", "Consulting", "TC", "Demand"],
};

export function createKeywordConfig(
  value: string,
  priority = 1,
  matchMode: KeywordMatchMode = "contains",
  enabled = true
): DatasetKeywordConfig {
  return {
    value: value.trim(),
    enabled,
    priority,
    matchMode,
  };
}

/** Enabled keywords sorted by priority (ascending). */
export function getEnabledKeywords(
  config: DatasetSearchConfig | null | undefined
): DatasetKeywordConfig[] {
  if (!config?.keywords?.length) return [];
  return [...config.keywords]
    .filter((keyword) => keyword.enabled && keyword.value.trim())
    .sort(
      (a, b) => a.priority - b.priority || a.value.localeCompare(b.value)
    );
}

function isMatchMode(value: unknown): value is KeywordMatchMode {
  return (
    value === "contains" ||
    value === "exact" ||
    value === "starts_with" ||
    value === "ends_with" ||
    value === "regex"
  );
}

export function normalizeKeywords(
  raw: unknown,
  legacySearch: unknown = [],
  legacyAttachment: unknown = []
): DatasetKeywordConfig[] {
  const fromObjects: DatasetKeywordConfig[] = [];

  if (Array.isArray(raw)) {
    raw.forEach((item, index) => {
      if (typeof item === "string") {
        const value = item.trim();
        if (!value) return;
        fromObjects.push(createKeywordConfig(value, index + 1));
        return;
      }
      if (!item || typeof item !== "object") return;
      const row = item as Record<string, unknown>;
      const value = typeof row.value === "string" ? row.value.trim() : "";
      if (!value) return;
      const priority =
        typeof row.priority === "number" && Number.isFinite(row.priority)
          ? Math.max(1, Math.floor(row.priority))
          : index + 1;
      const enabled = row.enabled !== false;
      const matchMode = isMatchMode(row.matchMode) ? row.matchMode : "contains";
      fromObjects.push({ value, enabled, priority, matchMode });
    });
  }

  if (fromObjects.length === 0) {
    const legacy: string[] = [];
    for (const source of [legacySearch, legacyAttachment]) {
      if (!Array.isArray(source)) continue;
      for (const item of source) {
        if (typeof item === "string" && item.trim()) legacy.push(item.trim());
      }
    }
    legacy.forEach((value, index) => {
      fromObjects.push(createKeywordConfig(value, index + 1));
    });
  }

  const seen = new Set<string>();
  const unique: DatasetKeywordConfig[] = [];
  for (const keyword of fromObjects.sort(
    (a, b) => a.priority - b.priority || a.value.localeCompare(b.value)
  )) {
    const key = `${keyword.matchMode}::${keyword.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(keyword);
  }

  return unique.map((keyword, index) => ({
    ...keyword,
    priority: index + 1,
  }));
}

export function createEmptyDatasetSearchConfig(
  seedName?: DatasetSyncName
): DatasetSearchConfig {
  const defaults = seedName ? DEFAULT_DATASET_KEYWORDS[seedName] : [];
  return {
    enabled: true,
    keywords: defaults.map((value, index) =>
      createKeywordConfig(value, index + 1)
    ),
    fileTypes: [...DEFAULT_FILE_TYPES],
    driveFolder: createEmptyDriveFolderConfig(seedName),
  };
}

export function createEmptyDatasetsMap(): DatasetSearchConfigMap {
  return {
    Lateral: createEmptyDatasetSearchConfig("Lateral"),
    Executive: createEmptyDatasetSearchConfig("Executive"),
    Consulting: createEmptyDatasetSearchConfig("Consulting"),
  };
}

export function createEmptyDatasetSetup(): Omit<
  DatasetSetupConfig,
  "updatedAt"
> {
  return {
    version: 1,
    gmailAddress: "",
    datasets: createEmptyDatasetsMap(),
    fileReplacePolicy: "replace",
    driveAccountEmail: "",
    driveAuthStatus: "pending",
    syncFrequency: "daily",
    syncTime: DEFAULT_SYNC_TIME,
    customCron: "0 7 * * *",
    customDays: [1, 2, 3, 4, 5],
    customTimes: [DEFAULT_SYNC_TIME],
    notifyOnFailure: true,
    notifyOnSuccess: false,
    alertEmail: "",
  };
}

function migrateLegacyDatasetMap(
  setup: Partial<DatasetSetupConfig> & {
    senderAddresses?: string[];
    attachmentPatterns?: string[];
    datasets?: Record<
      string,
      Partial<DatasetSearchConfig> & {
        senders?: unknown;
        senderEmails?: unknown;
      }
    >;
  }
): DatasetSearchConfigMap {
  const base = createEmptyDatasetsMap();
  const legacyFolder = {
    mode: setup.driveFolderMode,
    folderName: setup.driveFolderName,
    folderId: setup.driveFolderId,
    folderUrl: setup.driveFolderUrl,
  };

  if (setup.datasets) {
    for (const name of DATASET_SYNC_NAMES) {
      const incoming = setup.datasets[name];
      if (!incoming) continue;
      base[name] = {
        enabled: incoming.enabled ?? true,
        keywords: normalizeKeywords(
          incoming.keywords,
          incoming.searchKeywords,
          incoming.attachmentKeywords
        ),
        fileTypes:
          Array.isArray(incoming.fileTypes) && incoming.fileTypes.length > 0
            ? (incoming.fileTypes as DatasetFileType[])
            : [...DEFAULT_FILE_TYPES],
        driveFolder: normalizeDriveFolderConfig(
          incoming.driveFolder,
          legacyFolder,
          name
        ),
      };
      // Preserve empty keyword list from saved config; seed defaults only for brand-new setups
      if (
        base[name].keywords.length === 0 &&
        !incoming.keywords &&
        !incoming.searchKeywords &&
        !incoming.attachmentKeywords
      ) {
        base[name].keywords = createEmptyDatasetSearchConfig(name).keywords;
      }
    }
    return base;
  }

  const legacyPatterns = Array.isArray(setup.attachmentPatterns)
    ? setup.attachmentPatterns
    : [];

  for (const name of DATASET_SYNC_NAMES) {
    const namedPatterns = legacyPatterns.filter((pattern) =>
      pattern.toLowerCase().includes(name.toLowerCase())
    );
    base[name] = {
      enabled: true,
      keywords: normalizeKeywords(
        [],
        namedPatterns.length > 0
          ? namedPatterns
          : DEFAULT_DATASET_KEYWORDS[name],
        []
      ),
      fileTypes: [...DEFAULT_FILE_TYPES],
      driveFolder: normalizeDriveFolderConfig(undefined, legacyFolder, name),
    };
  }
  return base;
}

/** Normalize older saved configs to the per-dataset search model */
export function withSetupDefaults(
  setup: Partial<DatasetSetupConfig> & { syncFrequency?: string } | null | undefined
): Omit<DatasetSetupConfig, "updatedAt"> {
  const empty = createEmptyDatasetSetup();
  if (!setup) return empty;
  const syncFrequency =
    (setup.syncFrequency as string) === "custom_cron"
      ? "custom"
      : ((setup.syncFrequency as SyncFrequency | undefined) ?? empty.syncFrequency);
  return {
    ...empty,
    ...setup,
    version: 1,
    syncFrequency,
    datasets: migrateLegacyDatasetMap(setup),
    customDays: setup.customDays ?? empty.customDays,
    customTimes: setup.customTimes ?? empty.customTimes,
    notifyOnFailure: setup.notifyOnFailure ?? true,
    notifyOnSuccess: setup.notifyOnSuccess ?? false,
    alertEmail: setup.alertEmail ?? "",
  };
}
