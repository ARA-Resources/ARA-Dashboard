/**
 * Stage 24: lateral processing setup types — matches Next types/lateral-processing-setup.ts.
 */
import {
  createKeywordConfig,
  DEFAULT_DATASET_KEYWORDS,
  normalizeKeywords,
  type DatasetKeywordConfig,
  type DriveFolderInputMode,
} from "./dataset-setup.js";

export type ProcessingDatasetName = "Lateral";

export interface ProcessingDriveFolderConfig {
  mode: DriveFolderInputMode;
  folderName: string;
  folderId: string;
  folderUrl: string;
}

export interface ProcessingWorkbookConfig {
  fileId: string;
  fileName: string;
}

/**
 * Pipeline / VBA / reconcile still require the XLSM Master.
 * When Company primary master is a Google Sheet, processingMasterWorkbook holds the XLSM.
 */
export function resolvePipelineMasterWorkbook(
  setup: Pick<
    LateralDataProcessingSetup,
    "masterWorkbook" | "processingMasterWorkbook"
  >
): ProcessingWorkbookConfig {
  const processing = setup.processingMasterWorkbook;
  if (processing?.fileId?.trim()) {
    return {
      fileId: processing.fileId.trim(),
      fileName: processing.fileName?.trim() || processing.fileId.trim(),
    };
  }
  return {
    fileId: setup.masterWorkbook.fileId.trim(),
    fileName:
      setup.masterWorkbook.fileName?.trim() || setup.masterWorkbook.fileId.trim(),
  };
}

export const DEFAULT_LATERAL_MASTER_WORKBOOK_NAME =
  "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm";

export const DEFAULT_LATERAL_SOURCE_WORKSHEET = "ATCI DS";
export const DEFAULT_LATERAL_MASTER_SHEET = "Master Sheet";
export const DEFAULT_LATERAL_NEW_SHEET = "New Sheet";
export const DEFAULT_LATERAL_TIMEZONE = "Asia/Kolkata";

export type ScheduleFrequency =
  | "daily"
  | "weekdays"
  | "weekly"
  | "hourly"
  | "custom";

export const DEFAULT_CUSTOM_DAYS = [1, 2, 3, 4, 5];
export const DEFAULT_CUSTOM_TIMES = ["07:00"];

export function normalizeHhMm(value: string, fallback = "07:00"): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return fallback;
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function normalizeCustomDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [...DEFAULT_CUSTOM_DAYS];
  const days = value
    .map((item) => Number(item))
    .filter((day) => Number.isFinite(day) && day >= 0 && day <= 6)
    .map((day) => Math.floor(day));
  return Array.from(new Set(days)).sort((a, b) => a - b);
}

export function normalizeCustomTimes(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_CUSTOM_TIMES];
  const times = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalizeHhMm(item))
    .filter(Boolean);
  return Array.from(new Set(times)).sort();
}

export interface LateralScheduleConfig {
  frequency: ScheduleFrequency;
  syncTime: string;
  dayOfWeek: number;
  customDays: number[];
  customTimes: string[];
  enabled: boolean;
}

export interface LateralDataProcessingSetup {
  version: 1;
  updatedAt: string;
  datasetName: ProcessingDatasetName;
  sourceFolder: ProcessingDriveFolderConfig;
  sourceWorkbook: ProcessingWorkbookConfig;
  sourceWorksheet: string;
  masterWorkbook: ProcessingWorkbookConfig;
  processingMasterWorkbook?: ProcessingWorkbookConfig;
  masterNewSheet: string;
  masterSheet: string;
  destinationFolder: ProcessingDriveFolderConfig;
  keywords: DatasetKeywordConfig[];
  schedule: LateralScheduleConfig;
  timezone: string;
}

export function createEmptyProcessingDriveFolder(
  seedName: string
): ProcessingDriveFolderConfig {
  return {
    mode: "folder_id",
    folderName: seedName,
    folderId: "",
    folderUrl: "",
  };
}

function defaultLateralKeywords(): DatasetKeywordConfig[] {
  return DEFAULT_DATASET_KEYWORDS.Lateral.map((value, index) =>
    createKeywordConfig(value, index + 1)
  );
}

export function createEmptyLateralDataProcessingSetup(): Omit<
  LateralDataProcessingSetup,
  "updatedAt"
> {
  return {
    version: 1,
    datasetName: "Lateral",
    sourceFolder: createEmptyProcessingDriveFolder("ATCI Lateral Source"),
    sourceWorkbook: { fileId: "", fileName: "" },
    sourceWorksheet: DEFAULT_LATERAL_SOURCE_WORKSHEET,
    masterWorkbook: {
      fileId: "",
      fileName: DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
    },
    processingMasterWorkbook: undefined,
    masterNewSheet: DEFAULT_LATERAL_NEW_SHEET,
    masterSheet: DEFAULT_LATERAL_MASTER_SHEET,
    destinationFolder: createEmptyProcessingDriveFolder(
      "ATCI Lateral Processed"
    ),
    keywords: defaultLateralKeywords(),
    schedule: {
      frequency: "daily",
      syncTime: "07:00",
      dayOfWeek: 1,
      customDays: [...DEFAULT_CUSTOM_DAYS],
      customTimes: [...DEFAULT_CUSTOM_TIMES],
      enabled: true,
    },
    timezone: DEFAULT_LATERAL_TIMEZONE,
  };
}

export function withLateralDataProcessingDefaults(
  input:
    | Partial<LateralDataProcessingSetup>
    | (Record<string, unknown> & { updatedAt?: unknown })
    | null
    | undefined
): Omit<LateralDataProcessingSetup, "updatedAt"> {
  const empty = createEmptyLateralDataProcessingSetup();
  if (!input) return empty;
  const row = input as Record<string, unknown>;

  const normFolder = (
    value: unknown,
    seedName: string
  ): ProcessingDriveFolderConfig => {
    const base = createEmptyProcessingDriveFolder(seedName);
    if (!value || typeof value !== "object") return base;
    const obj = value as Record<string, unknown>;
    return {
      mode:
        obj.mode === "picker" ||
        obj.mode === "folder_id" ||
        obj.mode === "folder_url"
          ? obj.mode
          : base.mode,
      folderName:
        typeof obj.folderName === "string"
          ? obj.folderName.trim()
          : base.folderName,
      folderId: typeof obj.folderId === "string" ? obj.folderId.trim() : "",
      folderUrl: typeof obj.folderUrl === "string" ? obj.folderUrl.trim() : "",
    };
  };

  const normWorkbook = (value: unknown): ProcessingWorkbookConfig => {
    if (!value || typeof value !== "object") {
      return { fileId: "", fileName: empty.masterWorkbook.fileName };
    }
    const obj = value as Record<string, unknown>;
    return {
      fileId: typeof obj.fileId === "string" ? obj.fileId.trim() : "",
      fileName:
        typeof obj.fileName === "string" && obj.fileName.trim()
          ? obj.fileName.trim()
          : "",
    };
  };

  const scheduleRaw =
    row.schedule && typeof row.schedule === "object"
      ? (row.schedule as Record<string, unknown>)
      : {};
  const frequency =
    scheduleRaw.frequency === "hourly" ||
    scheduleRaw.frequency === "daily" ||
    scheduleRaw.frequency === "weekdays" ||
    scheduleRaw.frequency === "weekly" ||
    scheduleRaw.frequency === "custom"
      ? scheduleRaw.frequency
      : empty.schedule.frequency;

  return {
    version: 1,
    datasetName: "Lateral",
    sourceFolder: normFolder(row.sourceFolder, empty.sourceFolder.folderName),
    sourceWorkbook: {
      fileId:
        typeof (row.sourceWorkbook as { fileId?: string } | undefined)?.fileId ===
        "string"
          ? String(
              (row.sourceWorkbook as { fileId?: string }).fileId ?? ""
            ).trim()
          : "",
      fileName:
        typeof (row.sourceWorkbook as { fileName?: string } | undefined)
          ?.fileName === "string"
          ? String(
              (row.sourceWorkbook as { fileName?: string }).fileName ?? ""
            ).trim()
          : "",
    },
    sourceWorksheet:
      typeof row.sourceWorksheet === "string" && row.sourceWorksheet.trim()
        ? row.sourceWorksheet.trim()
        : empty.sourceWorksheet,
    masterWorkbook: (() => {
      const wb = normWorkbook(row.masterWorkbook);
      return {
        fileId: wb.fileId,
        fileName: wb.fileName || empty.masterWorkbook.fileName,
      };
    })(),
    processingMasterWorkbook: (() => {
      const wb = normWorkbook(row.processingMasterWorkbook);
      if (!wb.fileId) return undefined;
      return {
        fileId: wb.fileId,
        fileName: wb.fileName || DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
      };
    })(),
    masterNewSheet:
      typeof row.masterNewSheet === "string" && row.masterNewSheet.trim()
        ? row.masterNewSheet.trim()
        : empty.masterNewSheet,
    masterSheet:
      typeof row.masterSheet === "string" && row.masterSheet.trim()
        ? row.masterSheet.trim()
        : empty.masterSheet,
    destinationFolder: normFolder(
      row.destinationFolder,
      empty.destinationFolder.folderName
    ),
    keywords: normalizeKeywords(row.keywords, [], []).length
      ? normalizeKeywords(row.keywords, [], [])
      : empty.keywords,
    schedule: {
      frequency,
      syncTime: normalizeHhMm(
        typeof scheduleRaw.syncTime === "string" && scheduleRaw.syncTime.trim()
          ? scheduleRaw.syncTime.trim()
          : empty.schedule.syncTime
      ),
      dayOfWeek: (() => {
        const raw = Number(scheduleRaw.dayOfWeek);
        return Number.isFinite(raw)
          ? Math.min(6, Math.max(0, Math.floor(raw)))
          : 1;
      })(),
      customDays: normalizeCustomDays(scheduleRaw.customDays),
      customTimes: normalizeCustomTimes(
        Array.isArray(scheduleRaw.customTimes) && scheduleRaw.customTimes.length
          ? scheduleRaw.customTimes
          : [
              typeof scheduleRaw.syncTime === "string" &&
              scheduleRaw.syncTime.trim()
                ? scheduleRaw.syncTime.trim()
                : empty.schedule.syncTime,
            ]
      ),
      enabled: scheduleRaw.enabled !== false,
    },
    timezone:
      typeof row.timezone === "string" && row.timezone.trim()
        ? row.timezone.trim()
        : empty.timezone,
  };
}
