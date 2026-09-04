import type { ExcelCellValue, ExcelDataRow, ExcelSheetMeta } from "@/types/excel";
import { polishExcelDisplayValue } from "@/utils/excel-display";

export const LATERAL_MASTER_SHEET_NAME = "Master Sheet";
export const LATERAL_MASTER_HEADER_ROW = 1;

export const LATERAL_MASTER_PAGE_SIZE_OPTIONS = [
  10, 20, 50, 100, 250, 500,
] as const;

export type LateralMasterPageSize =
  (typeof LATERAL_MASTER_PAGE_SIZE_OPTIONS)[number];

export const DEFAULT_LATERAL_MASTER_PAGE_SIZE: LateralMasterPageSize = 20;

/**
 * Preferred display order for Job Status values when they exist in the sheet.
 * Does not invent options that are absent from Excel.
 */
export const LATERAL_JOB_STATUS_FILTER_VALUES = [
  "Active",
  "Closed",
  "New",
  "Reopen",
] as const;

export type LateralFilterControl =
  | "date"
  | "multi-select"
  | "searchable-multi-select"
  | "text";

export interface LateralMasterFilterField {
  /** Exact Master Sheet header */
  column: string;
  control: LateralFilterControl;
  values: string[];
  valueCount: number;
}

export interface LateralMasterFilterSchema {
  sheetName: string;
  sourceFile: string;
  sourceUrl?: string;
  fields: LateralMasterFilterField[];
  headers: string[];
  /** Last Run All summary for the Master Sheet status strip */
  lastRun?: {
    result: "success" | "partial" | "failed";
    ranAt: string;
    trigger: "scheduler" | "manual";
    sourceFilename: string | null;
    adhocDsDate: string | null;
    adhocDsDateLabel: string;
    failureReason: string | null;
    noNewSource: boolean;
    counts: {
      rowsImported: number;
      newCount: number;
      activeCount: number;
      reopenCount: number;
      closedCount: number;
    } | null;
  } | null;
}

export interface LateralMasterDateFilter {
  from?: string;
  to?: string;
}

export interface LateralMasterSheetQuery {
  page: number;
  pageSize: LateralMasterPageSize;
  /** Multi-select filters: column → selected display values */
  columnFilters: Record<string, string[]>;
  /** Free-text contains filters */
  textFilters: Record<string, string>;
  /** Inclusive date range filters (ISO date strings YYYY-MM-DD) */
  dateFilters: Record<string, LateralMasterDateFilter>;
}

function asText(value: ExcelCellValue): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split a free-text filter into search tokens (comma / semicolon / pipe).
 */
export function tokenizeTextFilterQuery(needle: string): string[] {
  return String(needle ?? "")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .split(/[,;/|]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Match Job Description / free-text filters.
 * - Default: consecutive phrase (spaces kept as part of the phrase)
 * - Comma/semicolon/pipe separated terms: every term must appear (AND)
 */
export function cellMatchesTextFilter(
  cellValue: ExcelCellValue,
  needle: string
): boolean {
  const raw = String(needle ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
  if (!raw) return true;

  const cell = asText(cellValue).toLowerCase();
  if (!cell) return false;

  // Multi-skill AND: "Python, AWS" or "Java; Spring"
  if (/[,;/|]/.test(raw)) {
    const tokens = tokenizeTextFilterQuery(raw);
    return tokens.length > 0 && tokens.every((token) => cell.includes(token));
  }

  // Phrase search: "Software Development" must appear contiguously
  const phrase = raw.replace(/\s+/g, " ").toLowerCase();
  return cell.includes(phrase);
}

function collectColumnStats(header: string, rows: ExcelDataRow[]) {
  const counts = new Map<string, { label: string; count: number }>();
  let nonNull = 0;
  let dateLike = 0;
  let totalLength = 0;

  for (const row of rows) {
    const raw = row[header];
    if (raw === null || raw === undefined || raw === "") continue;
    nonNull += 1;

    if (typeof raw === "number" && raw > 20000 && raw < 60000) {
      // Excel serial date range (approx)
      dateLike += 1;
    } else if (
      typeof raw === "string" &&
      /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(raw.trim())
    ) {
      dateLike += 1;
    }

    const text = asText(raw);
    if (!text) continue;
    totalLength += text.length;
    const label = polishExcelDisplayValue(text);
    const key = label.toLowerCase();
    const existing = counts.get(key);
    counts.set(key, {
      label: existing?.label ?? label,
      count: (existing?.count ?? 0) + 1,
    });
  }

  const values = [...counts.values()]
    .map((entry) => entry.label)
    .sort((a, b) => a.localeCompare(b));

  return {
    values,
    nonNull,
    unique: values.length,
    dateRatio: nonNull === 0 ? 0 : dateLike / nonNull,
    avgLength: nonNull === 0 ? 0 : totalLength / nonNull,
  };
}

/**
 * Infer filter UI from header name + column stats.
 * Does not hardcode which columns exist — only how to present matching headers.
 */
export function inferLateralFilterControl(
  header: string,
  stats: {
    unique: number;
    nonNull: number;
    dateRatio: number;
    avgLength: number;
  }
): LateralFilterControl | null {
  const name = header.trim();
  if (!name || name.toLowerCase() === "id") return null;
  if (stats.nonNull === 0) return null;

  // Date columns (exclude "Opened on Oorwin" — free text in Master Sheet)
  if (
    !/oorwin/i.test(name) &&
    (/^(date|opened|closed|updated|created)/i.test(name) ||
      /\bdate\b/i.test(name) ||
      stats.dateRatio >= 0.6)
  ) {
    return "date";
  }

  // Free-text search (Job Description and long text)
  if (
    /job\s*description|description|comments?|remarks?|notes?/i.test(name) ||
    (stats.avgLength > 60 && stats.unique > 20)
  ) {
    return "text";
  }

  // Skip near-unique ID columns (except Job Requisition ID can be text-searched)
  if (/job\s*requisition\s*id/i.test(name)) {
    return "text";
  }
  const uniqueness = stats.unique / Math.max(stats.nonNull, 1);
  if (uniqueness > 0.9 && stats.unique > 40) {
    return null;
  }

  // Searchable multi-select for high-cardinality people/skills/locations
  if (
    /primary\s*skills?|location|office|locate|poc|team\s*lead|team\s*member|recruiter|manager/i.test(
      name
    ) ||
    stats.unique > 25
  ) {
    return "searchable-multi-select";
  }

  // Low/medium cardinality categoricals
  if (stats.unique >= 2 && stats.unique <= 150) {
    return "multi-select";
  }

  if (stats.unique === 1) return "multi-select";

  return "text";
}

/** Order Job Status options from Excel; never add statuses that are not present. */
function orderJobStatusValues(values: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, value);
  }

  const ordered: string[] = [];
  for (const preferred of LATERAL_JOB_STATUS_FILTER_VALUES) {
    const hit = byKey.get(preferred.toLowerCase());
    if (hit) {
      ordered.push(hit);
      byKey.delete(preferred.toLowerCase());
    }
  }
  const rest = [...byKey.values()].sort((a, b) => a.localeCompare(b));
  return [...ordered, ...rest];
}

/**
 * Build Lateral Master Sheet filters from actual headers (order preserved).
 */
export function discoverLateralMasterFilters(
  headers: string[],
  rows: ExcelDataRow[]
): LateralMasterFilterField[] {
  const fields: LateralMasterFilterField[] = [];

  for (const header of headers) {
    const stats = collectColumnStats(header, rows);
    const isJobStatus = /job\s*status/i.test(header);
    const control = isJobStatus
      ? ("multi-select" as const)
      : inferLateralFilterControl(header, stats);
    if (!control) continue;

    let values = stats.values;
    if (isJobStatus) {
      values = orderJobStatusValues(values);
    }

    fields.push({
      column: header,
      control,
      values: control === "text" || control === "date" ? [] : values,
      valueCount:
        control === "text" || control === "date"
          ? stats.unique
          : values.length,
    });
  }

  return fields;
}

function parseCellDate(value: ExcelCellValue): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel serial → JS date (approximate, UTC)
    const utc = Date.UTC(1899, 11, 30) + value * 86400000;
    const d = new Date(utc);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const text = asText(value);
  if (!text) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDayStamp(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Parse filter boundary: YYYY-MM-DD or DD-MM-YYYY → UTC day Date. */
function parseFilterBoundary(raw: string): Date | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const y = Number(iso[1]);
    const mo = Number(iso[2]);
    const d = Number(iso[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (
      dt.getUTCFullYear() !== y ||
      dt.getUTCMonth() !== mo - 1 ||
      dt.getUTCDate() !== d
    ) {
      return null;
    }
    return dt;
  }

  const dmy = text.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmy) {
    const d = Number(dmy[1]);
    const mo = Number(dmy[2]);
    const y = Number(dmy[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (
      dt.getUTCFullYear() !== y ||
      dt.getUTCMonth() !== mo - 1 ||
      dt.getUTCDate() !== d
    ) {
      return null;
    }
    return dt;
  }

  return null;
}

/**
 * Apply Lateral Master Sheet filters. Multi-select OR within column, AND across.
 */
export function applyLateralMasterFilters(
  rows: ExcelDataRow[],
  query: Pick<
    LateralMasterSheetQuery,
    "columnFilters" | "textFilters" | "dateFilters"
  >
): ExcelDataRow[] {
  const columnEntries = Object.entries(query.columnFilters).filter(
    ([, values]) => values.length > 0
  );
  const textEntries = Object.entries(query.textFilters).filter(
    ([, value]) => value.trim().length > 0
  );
  const dateEntries = Object.entries(query.dateFilters).filter(
    ([, range]) => Boolean(range.from || range.to)
  );

  if (
    columnEntries.length === 0 &&
    textEntries.length === 0 &&
    dateEntries.length === 0
  ) {
    return rows;
  }

  return rows.filter((row) => {
    for (const [column, selected] of columnEntries) {
      const cell = polishExcelDisplayValue(asText(row[column]));
      if (!cell) return false;
      const ok = selected.some(
        (value) => value.toLowerCase() === cell.toLowerCase()
      );
      if (!ok) return false;
    }

    for (const [column, needle] of textEntries) {
      if (!cellMatchesTextFilter(row[column], needle)) return false;
    }

    for (const [column, range] of dateEntries) {
      const cellDate = parseCellDate(row[column]);
      if (!cellDate) return false;
      const stamp = toDayStamp(cellDate);
      if (range.from) {
        const from = parseFilterBoundary(range.from);
        if (from && stamp < toDayStamp(from)) return false;
      }
      if (range.to) {
        const to = parseFilterBoundary(range.to);
        if (to && stamp > toDayStamp(to)) return false;
      }
    }

    return true;
  });
}

export function paginateRows<T>(
  rows: T[],
  page: number,
  pageSize: number
): { rows: T[]; total: number; page: number; pageSize: number; pageCount: number } {
  const safeSize = Math.max(1, pageSize);
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / safeSize) || 1);
  const safePage = Math.min(Math.max(1, page), total === 0 ? 1 : pageCount);
  const start = (safePage - 1) * safeSize;
  return {
    rows: rows.slice(start, start + safeSize),
    total,
    page: safePage,
    pageSize: safeSize,
    pageCount: total === 0 ? 0 : pageCount,
  };
}

export interface LateralMasterSheetPageResult {
  businessUnitId: "lateral";
  sheetName: string;
  sourceFile: string;
  sourceUrl?: string;
  headers: string[];
  rows: ExcelDataRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  meta: ExcelSheetMeta;
}
