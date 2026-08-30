import type { ExcelCellValue, ExcelDataRow, ExcelSheetMeta } from "@/types/excel";
import { polishExcelDisplayValue } from "@/utils/excel-display";

/**
 * Executive Master Sheet workbook contract (Phase 1 / Aug 21 XLSM).
 * Header row = 1. Live columns = A–W only.
 */

export const EXECUTIVE_MASTER_SHEET_NAME = "Master Sheet";
export const EXECUTIVE_MASTER_HEADER_ROW = 1;

/**
 * Exact live Master Sheet headers in workbook order (A–W).
 * Do not include blank X–Y or historical Z.
 */
export const EXECUTIVE_MASTER_LIVE_COLUMNS = [
  "Job Requisition ID",
  "Market",
  "Primary skills",
  "Primary Location",
  "Level",
  "Must Have skills",
  "yrs of Experience",
  "Ageing Slab",
  "Location Flex",
  "Skill category",
  "Job Description",
  "Active Pipeline",
  "Job Status",
  "Posted",
  "Priority",
  "Opened on Oorwin",
  "Team Auto",
  "Team Manual",
  "Team Lead",
  "Team Member 1",
  "Team Member 2",
  "Date of New JR",
  "Niche Roles",
] as const;

export type ExecutiveMasterLiveColumn =
  (typeof EXECUTIVE_MASTER_LIVE_COLUMNS)[number];

/** Historical snapshot — never treat as live Job Status. */
export const EXECUTIVE_MASTER_HISTORICAL_STATUS_COLUMN =
  "Job Status - 11072025" as const;

export type ExecutiveMasterDataSourceKind = "drive" | "local" | "bundled";

/**
 * Strongly typed live Master Sheet row.
 * Values preserve workbook primitives; empty cells are null.
 */
export type ExecutiveMasterSheetRow = {
  id: string;
} & {
  [K in ExecutiveMasterLiveColumn]: ExcelCellValue;
};

export interface ExecutiveMasterSheetReadResult {
  businessUnitId: "executive";
  sheetName: string;
  sourceKind: ExecutiveMasterDataSourceKind;
  sourceFile: string;
  sourceLabel: string;
  /** Exact A–W live headers in workbook order. */
  headers: ExecutiveMasterLiveColumn[];
  rows: ExecutiveMasterSheetRow[];
  meta: ExcelSheetMeta & {
    sourceKind: ExecutiveMasterDataSourceKind;
    headerRow: number;
  };
}

function asTrimmedHeader(value: string): string {
  return value.replace(/\u00a0/g, " ").trim();
}

/**
 * Map parsed workbook headers/rows onto the live A–W contract.
 * Missing live headers cause validation failure (caller must validate first).
 * Extra workbook columns (including historical Z) are dropped.
 */
export function projectExecutiveMasterLiveColumns(
  headers: string[],
  rows: ExcelDataRow[]
): { headers: ExecutiveMasterLiveColumn[]; rows: ExecutiveMasterSheetRow[] } {
  const byLower = new Map<string, string>();
  for (const header of headers) {
    const key = asTrimmedHeader(header).toLowerCase();
    if (!key) continue;
    if (!byLower.has(key)) byLower.set(key, header);
  }

  const liveHeaders = [...EXECUTIVE_MASTER_LIVE_COLUMNS];
  const sourceKeys = liveHeaders.map((live) => {
    const source = byLower.get(live.toLowerCase());
    return source ?? live;
  });

  const projectedRows: ExecutiveMasterSheetRow[] = rows.map((row) => {
    const next = { id: String(row.id) } as ExecutiveMasterSheetRow;
    for (let i = 0; i < liveHeaders.length; i += 1) {
      const live = liveHeaders[i];
      const source = sourceKeys[i];
      const value = row[source];
      next[live] =
        value === undefined || value === null || value === ""
          ? null
          : (value as ExcelCellValue);
    }
    return next;
  });

  return { headers: liveHeaders, rows: projectedRows };
}

/**
 * Validate that every live A–W header is present (by exact name, case-insensitive).
 * Does not require historical Z.
 */
export function validateExecutiveMasterHeaders(headers: string[]): {
  ok: boolean;
  missing: string[];
  present: string[];
} {
  const byLower = new Set(
    headers.map((header) => asTrimmedHeader(header).toLowerCase()).filter(Boolean)
  );
  const missing: string[] = [];
  const present: string[] = [];

  for (const required of EXECUTIVE_MASTER_LIVE_COLUMNS) {
    if (byLower.has(required.toLowerCase())) {
      present.push(required);
    } else {
      missing.push(required);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    present,
  };
}

export function assertExecutiveMasterHeaders(headers: string[]): void {
  const result = validateExecutiveMasterHeaders(headers);
  if (result.ok) return;
  throw new Error(
    `Executive Master Sheet is missing required headers: ${result.missing.join(", ")}`
  );
}

export const EXECUTIVE_MASTER_PAGE_SIZE_OPTIONS = [
  10, 20, 50, 100, 250, 500,
] as const;

export type ExecutiveMasterPageSize =
  (typeof EXECUTIVE_MASTER_PAGE_SIZE_OPTIONS)[number];

export const DEFAULT_EXECUTIVE_MASTER_PAGE_SIZE: ExecutiveMasterPageSize = 20;

/** Preferred Job Status order when values exist in Excel — never invents values. */
export const EXECUTIVE_JOB_STATUS_FILTER_VALUES = [
  "Active",
  "Closed",
  "New",
] as const;

export type ExecutiveFilterControl =
  | "date"
  | "multi-select"
  | "searchable-multi-select"
  | "text";

export interface ExecutiveMasterFilterField {
  column: string;
  control: ExecutiveFilterControl;
  values: string[];
  valueCount: number;
}

export interface ExecutiveMasterFilterSchema {
  sheetName: string;
  sourceFile: string;
  sourceUrl?: string;
  sourceKind: ExecutiveMasterDataSourceKind;
  fields: ExecutiveMasterFilterField[];
  headers: string[];
}

export interface ExecutiveMasterDateFilter {
  from?: string;
  to?: string;
}

export interface ExecutiveMasterSheetQuery {
  page: number;
  pageSize: ExecutiveMasterPageSize;
  columnFilters: Record<string, string[]>;
  textFilters: Record<string, string>;
  dateFilters: Record<string, ExecutiveMasterDateFilter>;
}

export interface ExecutiveMasterSheetPageResult {
  businessUnitId: "executive";
  sheetName: string;
  sourceFile: string;
  sourceUrl?: string;
  sourceKind: ExecutiveMasterDataSourceKind;
  headers: string[];
  rows: ExecutiveMasterSheetRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  meta: ExcelSheetMeta & {
    sourceKind: ExecutiveMasterDataSourceKind;
    headerRow: number;
  };
}

function asText(value: ExcelCellValue): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeTextFilterQuery(needle: string): string[] {
  return String(needle ?? "")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .split(/[,;/|]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

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

  if (/[,;/|]/.test(raw)) {
    const tokens = tokenizeTextFilterQuery(raw);
    return tokens.length > 0 && tokens.every((token) => cell.includes(token));
  }

  return cell.includes(raw.replace(/\s+/g, " ").toLowerCase());
}

function collectColumnStats(header: string, rows: ExecutiveMasterSheetRow[]) {
  const counts = new Map<string, { label: string; count: number }>();
  let nonNull = 0;
  let dateLike = 0;
  let totalLength = 0;

  for (const row of rows) {
    const raw = row[header as ExecutiveMasterLiveColumn];
    if (raw === null || raw === undefined || raw === "") continue;
    nonNull += 1;

    if (typeof raw === "number" && raw > 20000 && raw < 60000) {
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

export function inferExecutiveFilterControl(
  header: string,
  stats: {
    unique: number;
    nonNull: number;
    dateRatio: number;
    avgLength: number;
  }
): ExecutiveFilterControl | null {
  const name = header.trim();
  if (!name) return null;
  if (stats.nonNull === 0) return null;
  if (/^job\s*status\s*-/i.test(name)) return null;

  if (
    /^(date|opened|closed|updated|created)/i.test(name) ||
    /\bdate\b/i.test(name) ||
    stats.dateRatio >= 0.6
  ) {
    return "date";
  }

  if (
    /job\s*description|must\s*have\s*skills?|description|comments?|remarks?|notes?/i.test(
      name
    ) ||
    (stats.avgLength > 60 && stats.unique > 20)
  ) {
    return "text";
  }

  if (/job\s*requisition\s*id/i.test(name)) return "text";

  const uniqueness = stats.unique / Math.max(stats.nonNull, 1);
  if (uniqueness > 0.9 && stats.unique > 40) return null;

  if (
    /primary\s*skills?|location|office|locate|poc|team\s*lead|team\s*member|recruiter|manager/i.test(
      name
    ) ||
    stats.unique > 25
  ) {
    return "searchable-multi-select";
  }

  if (stats.unique >= 2 && stats.unique <= 150) return "multi-select";
  if (stats.unique === 1) return "multi-select";
  return "text";
}

function orderJobStatusValues(values: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, value);
  }
  const ordered: string[] = [];
  for (const preferred of EXECUTIVE_JOB_STATUS_FILTER_VALUES) {
    const hit = byKey.get(preferred.toLowerCase());
    if (hit) {
      ordered.push(hit);
      byKey.delete(preferred.toLowerCase());
    }
  }
  return [...ordered, ...[...byKey.values()].sort((a, b) => a.localeCompare(b))];
}

export function discoverExecutiveMasterFilters(
  headers: string[],
  rows: ExecutiveMasterSheetRow[]
): ExecutiveMasterFilterField[] {
  const fields: ExecutiveMasterFilterField[] = [];

  for (const header of headers) {
    if (/^job\s*status\s*-/i.test(header)) continue;
    const stats = collectColumnStats(header, rows);
    const isJobStatus = /^job\s*status$/i.test(header.trim());
    const isJobDescription = isExecutiveJobDescriptionColumn(header);
    const isMustHave = isExecutiveMustHaveSkillsColumn(header);
    const isLiveContract = EXECUTIVE_MASTER_LIVE_COLUMNS.includes(
      header as ExecutiveMasterLiveColumn
    );

    let control: ExecutiveFilterControl | null = isJobStatus
      ? "multi-select"
      : isJobDescription || isMustHave
        ? "text"
        : inferExecutiveFilterControl(header, stats);

    // Executive Master Sheet: always expose a filter for every live A–W column.
    if (!control && isLiveContract) {
      if (
        /^(date|opened)/i.test(header) ||
        /\bdate\b/i.test(header) ||
        stats.dateRatio >= 0.4
      ) {
        control = "date";
      } else if (stats.unique > 40 || stats.avgLength > 40) {
        control = "text";
      } else if (stats.unique > 25) {
        control = "searchable-multi-select";
      } else {
        control = "multi-select";
      }
    }

    if (!control) continue;

    let values = stats.values;
    if (isJobStatus) values = orderJobStatusValues(values);

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

export function applyExecutiveMasterFilters(
  rows: ExecutiveMasterSheetRow[],
  query: Pick<
    ExecutiveMasterSheetQuery,
    "columnFilters" | "textFilters" | "dateFilters"
  >
): ExecutiveMasterSheetRow[] {
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
      const cell = polishExcelDisplayValue(
        asText(row[column as ExecutiveMasterLiveColumn])
      );
      if (!cell) return false;
      if (
        !selected.some((value) => value.toLowerCase() === cell.toLowerCase())
      ) {
        return false;
      }
    }

    for (const [column, needle] of textEntries) {
      if (
        !cellMatchesTextFilter(
          row[column as ExecutiveMasterLiveColumn],
          needle
        )
      ) {
        return false;
      }
    }

    for (const [column, range] of dateEntries) {
      const cellDate = parseCellDate(
        row[column as ExecutiveMasterLiveColumn]
      );
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

export function paginateExecutiveRows<T>(
  rows: T[],
  page: number,
  pageSize: number
): {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
} {
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

export function isExecutiveJobDescriptionColumn(header: string): boolean {
  return /^job\s*description$/i.test(header.trim());
}

export function isExecutiveMustHaveSkillsColumn(header: string): boolean {
  return /^must\s*have\s*skills?$/i.test(header.trim());
}
