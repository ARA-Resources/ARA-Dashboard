import "server-only";

import type postgres from "postgres";
import {
  listCandidateMasterRows,
  type CandidateMasterRow,
} from "@/services/persistence/read-candidate-master";
import {
  CANDIDATE_MASTER_COLUMN_MAP,
  CANDIDATE_MASTER_EXCEL_HEADERS,
  CANDIDATE_MASTER_PG_SOURCE_FILE,
  type CandidateMasterExcelHeader,
} from "@/services/persistence/candidate-master-sheet-columns";
import {
  isCandidateRoleNameColumn,
  type CandidateFilterControl,
  type CandidateMasterDateFilter,
  type CandidateMasterFilterField,
  type CandidateMasterPageSize,
} from "@/services/excel/candidate-master-sheet";

/**
 * Read-only in-memory filter/paginate engine for the Candidate Master Sheet
 * page, sourced from PostgreSQL `candidate_master` (14 columns).
 *
 * Fully standalone: does not import from, or share filter/pagination logic
 * with, the lateral/executive equivalents (mirrors their shape, not their
 * code). At ~12k rows, loading the full table per request and filtering in
 * memory is simple and fast enough (same approach the Executive Master
 * Sheet page already uses at smaller scale); can be revisited if usage
 * shows it's a bottleneck.
 */

export type SqlClient = ReturnType<typeof postgres>;

export const CANDIDATE_MASTER_SHEET_PG_NAME = "ATCI";

export type CandidateMasterSheetPgRow = {
  id: string;
} & {
  [K in CandidateMasterExcelHeader]: string;
};

export interface CandidateMasterSheetSchema {
  sheetName: string;
  sourceFile: string;
  sourceKind: "postgres";
  fields: CandidateMasterFilterField[];
  headers: string[];
}

export interface CandidateMasterSheetQuery {
  page: number;
  pageSize: CandidateMasterPageSize;
  columnFilters: Record<string, string[]>;
  textFilters: Record<string, string>;
  dateFilters: Record<string, CandidateMasterDateFilter>;
}

export interface CandidateMasterSheetPageResult {
  sheetName: string;
  sourceFile: string;
  sourceKind: "postgres";
  headers: string[];
  rows: CandidateMasterSheetPgRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

function toSheetRow(row: CandidateMasterRow): CandidateMasterSheetPgRow {
  const next = { id: String(row.id) } as CandidateMasterSheetPgRow;
  for (const mapping of CANDIDATE_MASTER_COLUMN_MAP) {
    const value = row[mapping.dbColumn as keyof CandidateMasterRow];
    next[mapping.excelHeader] = String(value ?? "-");
  }
  return next;
}

async function loadRows(
  sqlClient?: SqlClient
): Promise<CandidateMasterSheetPgRow[]> {
  const rows = await listCandidateMasterRows(sqlClient);
  return rows.map(toSheetRow);
}

function asText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

export function tokenizeCandidateTextFilterQuery(needle: string): string[] {
  return String(needle ?? "")
    .toLowerCase()
    .replace(/ /g, " ")
    .split(/[,;/|]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function candidateCellMatchesTextFilter(
  cellValue: string | null | undefined,
  needle: string
): boolean {
  const raw = String(needle ?? "").replace(/ /g, " ").trim();
  if (!raw) return true;
  const cell = asText(cellValue).toLowerCase();
  if (!cell) return false;
  if (/[,;/|]/.test(raw)) {
    const tokens = tokenizeCandidateTextFilterQuery(raw);
    return tokens.length > 0 && tokens.every((token) => cell.includes(token));
  }
  return cell.includes(raw.replace(/\s+/g, " ").toLowerCase());
}

function collectColumnStats(
  header: CandidateMasterExcelHeader,
  rows: CandidateMasterSheetPgRow[]
) {
  const counts = new Map<string, { label: string; count: number }>();
  let nonNull = 0;
  let totalLength = 0;

  for (const row of rows) {
    const raw = row[header];
    if (raw === null || raw === undefined || raw === "") continue;
    nonNull += 1;
    const text = asText(raw);
    if (!text) continue;
    totalLength += text.length;
    const key = text.toLowerCase();
    const existing = counts.get(key);
    counts.set(key, { label: existing?.label ?? text, count: (existing?.count ?? 0) + 1 });
  }

  const values = [...counts.values()]
    .map((entry) => entry.label)
    .sort((a, b) => a.localeCompare(b));

  return {
    values,
    nonNull,
    unique: values.length,
    avgLength: nonNull === 0 ? 0 : totalLength / nonNull,
  };
}

function inferCandidateFilterControl(
  header: CandidateMasterExcelHeader,
  stats: { unique: number; nonNull: number; avgLength: number }
): CandidateFilterControl {
  if (/^date\b|date of upload|submitted date/i.test(header)) return "date";
  if (isCandidateRoleNameColumn(header)) return "text";
  if (stats.unique > 40 || stats.avgLength > 40) return "text";
  if (stats.unique > 25) return "searchable-multi-select";
  return "multi-select";
}

export function discoverCandidateMasterSheetFilters(
  rows: CandidateMasterSheetPgRow[]
): CandidateMasterFilterField[] {
  const fields: CandidateMasterFilterField[] = [];

  for (const header of CANDIDATE_MASTER_EXCEL_HEADERS) {
    const stats = collectColumnStats(header, rows);
    const control = inferCandidateFilterControl(header, stats);
    const values = control === "text" || control === "date" ? [] : stats.values;

    fields.push({
      column: header,
      control,
      values,
      valueCount: control === "text" || control === "date" ? stats.unique : values.length,
    });
  }

  return fields;
}

/**
 * Parses a DD/MM/YYYY text value (the format every valid date is stored in
 * by the import script). Anything else (malformed source values preserved
 * verbatim, or the literal "-" for blanks) simply doesn't match a date
 * filter — consistent with how non-date text is treated elsewhere.
 */
function parseDdMmYyyy(value: string | null | undefined): Date | null {
  const text = asText(value);
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt;
}

function toDayStamp(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function parseFilterBoundary(raw: string): Date | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) {
    const y = Number(iso[1]);
    const mo = Number(iso[2]);
    const d = Number(iso[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
      ? dt
      : null;
  }
  return null;
}

export function applyCandidateMasterSheetFilters(
  rows: CandidateMasterSheetPgRow[],
  query: Pick<CandidateMasterSheetQuery, "columnFilters" | "textFilters" | "dateFilters">
): CandidateMasterSheetPgRow[] {
  const columnEntries = Object.entries(query.columnFilters).filter(([, v]) => v.length > 0);
  const textEntries = Object.entries(query.textFilters).filter(([, v]) => v.trim().length > 0);
  const dateEntries = Object.entries(query.dateFilters).filter(
    ([, r]) => Boolean(r.from || r.to)
  );

  if (columnEntries.length === 0 && textEntries.length === 0 && dateEntries.length === 0) {
    return rows;
  }

  return rows.filter((row) => {
    for (const [column, selected] of columnEntries) {
      const cell = asText(row[column as CandidateMasterExcelHeader]);
      if (!cell) return false;
      if (!selected.some((value) => value.toLowerCase() === cell.toLowerCase())) return false;
    }

    for (const [column, needle] of textEntries) {
      if (!candidateCellMatchesTextFilter(row[column as CandidateMasterExcelHeader], needle)) {
        return false;
      }
    }

    for (const [column, range] of dateEntries) {
      const cellDate = parseDdMmYyyy(row[column as CandidateMasterExcelHeader]);
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

function paginate<T>(rows: T[], page: number, pageSize: number) {
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

export async function getCandidateMasterSheetSchema(
  sqlClient?: SqlClient
): Promise<CandidateMasterSheetSchema> {
  const rows = await loadRows(sqlClient);
  return {
    sheetName: CANDIDATE_MASTER_SHEET_PG_NAME,
    sourceFile: CANDIDATE_MASTER_PG_SOURCE_FILE,
    sourceKind: "postgres",
    headers: [...CANDIDATE_MASTER_EXCEL_HEADERS],
    fields: discoverCandidateMasterSheetFilters(rows),
  };
}

export async function queryCandidateMasterSheetPage(
  query: CandidateMasterSheetQuery,
  sqlClient?: SqlClient
): Promise<CandidateMasterSheetPageResult> {
  const rows = await loadRows(sqlClient);
  const filtered = applyCandidateMasterSheetFilters(rows, query);
  const page = paginate(filtered, query.page, query.pageSize);

  return {
    sheetName: CANDIDATE_MASTER_SHEET_PG_NAME,
    sourceFile: CANDIDATE_MASTER_PG_SOURCE_FILE,
    sourceKind: "postgres",
    headers: [...CANDIDATE_MASTER_EXCEL_HEADERS],
    rows: page.rows,
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
    pageCount: page.pageCount,
  };
}
