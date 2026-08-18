import type { DriveFolderInputMode, DatasetKeywordConfig } from "@/types/dataset-setup";
import {
  createKeywordConfig,
  DEFAULT_DATASET_KEYWORDS,
  normalizeKeywords,
} from "@/types/dataset-setup";
import type { ScheduleFrequency } from "@/types/dataset-schedule";
import {
  DEFAULT_CUSTOM_DAYS,
  DEFAULT_CUSTOM_TIMES,
  normalizeCustomDays,
  normalizeCustomTimes,
  normalizeHhMm,
} from "@/types/dataset-schedule";

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

/** Native Google Sheets mime — allowed as the primary Lateral Master Sheet host. */
export const GOOGLE_SHEETS_MIME_TYPE =
  "application/vnd.google-apps.spreadsheet";

export function isGoogleSpreadsheetMime(
  mimeType: string | null | undefined
): boolean {
  return (mimeType || "").trim() === GOOGLE_SHEETS_MIME_TYPE;
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

/** Default display/search name — not a hardcoded required file ID. */
export const DEFAULT_LATERAL_MASTER_WORKBOOK_NAME =
  "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm";

export const DEFAULT_LATERAL_SOURCE_WORKSHEET = "ATCI DS";
export const DEFAULT_LATERAL_MASTER_SHEET = "Master Sheet";
export const DEFAULT_LATERAL_NEW_SHEET = "New Sheet";
export const DEFAULT_LATERAL_TIMEZONE = "Asia/Kolkata";

export interface LateralScheduleConfig {
  frequency: ScheduleFrequency;
  /** HH:mm — used for daily / weekdays / weekly (and fallback for custom) */
  syncTime: string;
  /** 0=Sunday … 6=Saturday — used when frequency is weekly */
  dayOfWeek: number;
  /** Custom frequency: selected weekdays (0=Sun … 6=Sat) */
  customDays: number[];
  /** Custom frequency: one or more HH:mm run times */
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
  /**
   * Primary Lateral Master workbook shown in Company → Accenture → Lateral → Master Sheet.
   * May be a native Google Sheet (preferred) or the XLSM Master.
   */
  masterWorkbook: ProcessingWorkbookConfig;
  /**
   * XLSM used by Lateral processing pipeline (reconcile / VBA / Drive update).
   * Required when masterWorkbook is a Google Sheet; otherwise optional.
   */
  processingMasterWorkbook?: ProcessingWorkbookConfig;
  masterNewSheet: string;
  masterSheet: string;
  destinationFolder: ProcessingDriveFolderConfig;
  /** Gmail keywords for Lateral assignment (also synced into Dataset setup). */
  keywords: DatasetKeywordConfig[];
  /** Lateral automation schedule seed */
  schedule: LateralScheduleConfig;
  /** Preferred scheduler timezone for Lateral runs */
  timezone: string;
}

export interface WorkbookOption {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  webViewLink: string | null;
}

export interface DriveFolderOption {
  id: string;
  name: string;
  modifiedTime: string | null;
  webViewLink: string | null;
}

export interface LateralDataProcessingValidationResult {
  sourceFolder: { ok: boolean; message: string };
  sourceWorkbook: { ok: boolean; message: string };
  sourceWorksheet: { ok: boolean; message: string };
  masterWorkbook: { ok: boolean; message: string };
  masterNewSheet: { ok: boolean; message: string };
  masterSheet: { ok: boolean; message: string };
  destinationFolder: { ok: boolean; message: string };
  keywords?: { ok: boolean; message: string };
  schedule?: { ok: boolean; message: string };
  timezone?: { ok: boolean; message: string };
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
        typeof obj.folderName === "string" ? obj.folderName.trim() : base.folderName,
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
        return Number.isFinite(raw) ? Math.min(6, Math.max(0, Math.floor(raw))) : 1;
      })(),
      customDays: normalizeCustomDays(scheduleRaw.customDays),
      customTimes: normalizeCustomTimes(
        Array.isArray(scheduleRaw.customTimes) && scheduleRaw.customTimes.length
          ? scheduleRaw.customTimes
          : [
              typeof scheduleRaw.syncTime === "string" && scheduleRaw.syncTime.trim()
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
