import type {
  DatasetFileType,
  DatasetSearchConfig,
  DatasetSetupConfig,
} from "@/types/dataset-setup";
import { DEFAULT_FILE_TYPES } from "@/types/dataset-setup";
import type { DatasetSyncName } from "@/types/dataset-sync";

const DATASET_TZ =
  process.env.ARA_DATASET_TZ?.trim() ||
  process.env.TZ?.trim().replace(/^:/, "") ||
  "Asia/Kolkata";

/** Calendar day in YYYY-MM-DD for the dataset timezone. */
export function getCalendarDateInTimezone(
  date: Date = new Date(),
  timeZone = DATASET_TZ
): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Epoch ms for 00:00:00 of the given calendar day in the dataset timezone. */
export function getStartOfCalendarDayMs(
  isoDate: string = getCalendarDateInTimezone(),
  timeZone = DATASET_TZ
): number {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  function zonedParts(ms: number) {
    const parts = dtf.formatToParts(new Date(ms));
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") map[part.type] = part.value;
    }
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour),
      minute: Number(map.minute),
      second: Number(map.second),
    };
  }

  // Convert wall time on isoDate 00:00:00 → UTC ms
  let guess = utcGuess;
  for (let i = 0; i < 3; i += 1) {
    const p = zonedParts(guess);
    const asUtc = Date.UTC(
      p.year,
      p.month - 1,
      p.day,
      p.hour,
      p.minute,
      p.second
    );
    const desired = Date.UTC(year, month - 1, day, 0, 0, 0);
    guess += desired - asUtc;
  }
  return guess;
}

/** Shift a YYYY-MM-DD calendar date by `deltaDays` (local calendar arithmetic). */
export function shiftCalendarDate(isoDate: string, deltaDays: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return utc.toISOString().slice(0, 10);
}

/** Gmail `after:` / `before:` calendar tokens use YYYY/M/D. */
export function toGmailDateToken(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${year}/${month}/${day}`;
}

/** Gmail also accepts Unix epoch seconds with after:/before: for finer windows. */
export function toGmailEpochSeconds(ms: number): number {
  return Math.max(0, Math.floor(ms / 1000));
}

export type ScanDateMode = "today" | "yesterday" | "custom";
export type GmailScanMode = "incremental" | "date";

export function resolveScanDate(options?: {
  mode?: ScanDateMode | string | null;
  date?: string | null;
}): string {
  const today = getCalendarDateInTimezone();
  const mode = options?.mode ?? "today";
  if (mode === "yesterday") return shiftCalendarDate(today, -1);
  if (
    mode === "custom" &&
    options?.date &&
    /^\d{4}-\d{2}-\d{2}$/.test(options.date)
  ) {
    return options.date;
  }
  if (options?.date && /^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    return options.date;
  }
  return today;
}

function fileTypeClause(fileTypes?: DatasetFileType[]) {
  return fileTypeClauseForQuery(fileTypes);
}

/** Excel filename clause for Gmail search (exported for Lateral discovery). */
export function fileTypeClauseForQuery(fileTypes?: DatasetFileType[]) {
  const types =
    fileTypes && fileTypes.length > 0 ? fileTypes : DEFAULT_FILE_TYPES;
  return `(${types.map((type) => `filename:${type}`).join(" OR ")})`;
}

/**
 * Incremental inbox query: Excel emails received after last successful sync.
 * Uses Gmail epoch-second after: for sub-day precision.
 */
export function buildAfterTimestampExcelQuery(options: {
  afterMs: number;
  fileTypes?: DatasetFileType[];
}): string {
  const afterSec = toGmailEpochSeconds(options.afterMs);
  return [
    "in:inbox",
    `after:${afterSec}`,
    fileTypeClause(options.fileTypes),
  ].join(" ");
}

/**
 * Build a single calendar-day inbox query for Excel attachments.
 * Used for manual browse (Today / Yesterday / Custom Date).
 */
export function buildDateScopedExcelQuery(options: {
  date: string;
  fileTypes?: DatasetFileType[];
}): string {
  const after = toGmailDateToken(options.date);
  const before = toGmailDateToken(shiftCalendarDate(options.date, 1));

  return [
    "in:inbox",
    `after:${after}`,
    `before:${before}`,
    fileTypeClause(options.fileTypes),
  ].join(" ");
}

/**
 * @deprecated Prefer buildAfterTimestampExcelQuery / buildDateScopedExcelQuery
 */
export function buildDatasetGmailSearchQuery(
  config: DatasetSearchConfig,
  options?: { date?: string; afterMs?: number }
): string {
  if (options?.afterMs != null) {
    return buildAfterTimestampExcelQuery({
      afterMs: options.afterMs,
      fileTypes: config.fileTypes,
    });
  }
  const date = options?.date ?? getCalendarDateInTimezone();
  return buildDateScopedExcelQuery({
    date,
    fileTypes: config.fileTypes,
  });
}

function collectEnabledFileTypes(setup: DatasetSetupConfig): DatasetFileType[] {
  const enabledTypes = new Set<DatasetFileType>();
  for (const config of Object.values(setup.datasets ?? {})) {
    if (!config?.enabled) continue;
    for (const type of config.fileTypes?.length
      ? config.fileTypes
      : DEFAULT_FILE_TYPES) {
      enabledTypes.add(type);
    }
  }
  return enabledTypes.size > 0
    ? Array.from(enabledTypes)
    : [...DEFAULT_FILE_TYPES];
}

/** Shared preview query for ops/health — prefers incremental when afterMs given. */
export function buildGmailSearchQuery(
  setup: DatasetSetupConfig,
  options?: { date?: string; afterMs?: number }
): string {
  const fileTypes = collectEnabledFileTypes(setup);
  if (options?.afterMs != null) {
    return buildAfterTimestampExcelQuery({
      afterMs: options.afterMs,
      fileTypes,
    });
  }
  const date = options?.date ?? getCalendarDateInTimezone();
  return buildDateScopedExcelQuery({ date, fileTypes });
}

export function buildAllDatasetQueries(
  setup: DatasetSetupConfig,
  options?: {
    datasetNames?: DatasetSyncName[];
    date?: string;
    afterMs?: number;
  }
): Array<{
  datasetName: DatasetSyncName;
  query: string;
  config: DatasetSearchConfig;
}> {
  const results: Array<{
    datasetName: DatasetSyncName;
    query: string;
    config: DatasetSearchConfig;
  }> = [];

  const allow = options?.datasetNames?.length
    ? new Set(options.datasetNames)
    : null;

  const sharedQuery = buildGmailSearchQuery(setup, {
    date: options?.date,
    afterMs: options?.afterMs,
  });

  for (const datasetName of ["Lateral", "Executive", "Consulting"] as const) {
    if (allow && !allow.has(datasetName)) continue;
    const config = setup.datasets?.[datasetName];
    if (!config?.enabled) continue;
    results.push({
      datasetName,
      query: sharedQuery,
      config,
    });
  }
  return results;
}

export function matchesFileType(
  filename: string,
  fileTypes: DatasetFileType[]
): boolean {
  const types = fileTypes.length > 0 ? fileTypes : DEFAULT_FILE_TYPES;
  const lower = filename.trim().toLowerCase();
  return types.some((type) => lower.endsWith(`.${type}`));
}

export function isExcelFilename(filename: string): boolean {
  return /\.(xlsx|xlsm|xls)$/i.test(filename.trim());
}

export function normalizeAttachmentKey(filename: string): string {
  return filename.trim().toLowerCase().replace(/\s+/g, " ");
}
