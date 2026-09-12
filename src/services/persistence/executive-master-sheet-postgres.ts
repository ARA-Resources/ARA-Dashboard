import "server-only";

import type postgres from "postgres";
import {
  listExecutiveMasterRows,
  type ExecutiveMasterRow,
} from "@/services/persistence/read-executive-master";
import {
  EXECUTIVE_MASTER_COLUMN_MAP,
  EXECUTIVE_MASTER_EXCEL_HEADERS,
  EXECUTIVE_MASTER_PG_SOURCE_FILE,
  type ExecutiveMasterExcelHeader,
} from "@/services/persistence/executive-master-sheet-columns";
import {
  cellMatchesTextFilter,
  isExecutiveJobDescriptionColumn,
  isExecutiveMustHaveSkillsColumn,
  inferExecutiveFilterControl,
  paginateExecutiveRows,
  EXECUTIVE_JOB_STATUS_FILTER_VALUES,
  type ExecutiveFilterControl,
  type ExecutiveMasterDateFilter,
  type ExecutiveMasterFilterField,
  type ExecutiveMasterPageSize,
} from "@/services/excel/executive-master-sheet";
import { polishExcelDisplayValue } from "@/utils/excel-display";
import type { ExcelCellValue } from "@/types/excel";

/**
 * Read-only in-memory filter/paginate engine for the Executive Master Sheet
 * page, sourced from PostgreSQL `executive_master` (13 real columns) instead
 * of the legacy 23-column XLSM contract.
 *
 * Deliberately does NOT reuse `applyExecutiveMasterFilters` /
 * `discoverExecutiveMasterFilters` from `@/services/excel/executive-master-sheet`
 * — those are typed against the old 23-column row shape, and that file is left
 * untouched because `refresh-executive-home-widgets-metrics.ts` (Home page
 * widget) still depends on it. The generic, row-shape-agnostic pieces
 * (control inference, text matching, pagination, page-size constants) ARE
 * reused directly from there.
 *
 * At ~1,500 rows, loading the full table per request and filtering in memory
 * (mirrors the pattern this page already used against Excel) is simpler than
 * porting Lateral's SQL WHERE/LIMIT/OFFSET architecture, which exists to
 * handle Lateral's much larger (~13k row) table.
 */

export type SqlClient = ReturnType<typeof postgres>;

export const EXECUTIVE_MASTER_SHEET_PG_NAME = "Master Sheet";

export type ExecutiveMasterSheetPgRow = {
  id: string;
} & {
  [K in ExecutiveMasterExcelHeader]: ExcelCellValue;
};

export interface ExecutiveMasterSheetSchema {
  sheetName: string;
  sourceFile: string;
  sourceKind: "postgres";
  fields: ExecutiveMasterFilterField[];
  headers: string[];
}

export interface ExecutiveMasterSheetQuery {
  page: number;
  pageSize: ExecutiveMasterPageSize;
  columnFilters: Record<string, string[]>;
  textFilters: Record<string, string>;
  dateFilters: Record<string, ExecutiveMasterDateFilter>;
}

export interface ExecutiveMasterSheetPageResult {
  sheetName: string;
  sourceFile: string;
  sourceKind: "postgres";
  headers: string[];
  rows: ExecutiveMasterSheetPgRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

function toSheetRow(row: ExecutiveMasterRow): ExecutiveMasterSheetPgRow {
  const next = { id: row.job_requisition_id } as ExecutiveMasterSheetPgRow;
  for (const mapping of EXECUTIVE_MASTER_COLUMN_MAP) {
    const value = row[mapping.dbColumn as keyof ExecutiveMasterRow];
    next[mapping.excelHeader] = (value ?? null) as ExcelCellValue;
  }
  return next;
}

async function loadRows(
  sqlClient?: SqlClient
): Promise<ExecutiveMasterSheetPgRow[]> {
  const rows = await listExecutiveMasterRows(sqlClient);
  return rows.map(toSheetRow);
}

function asText(value: ExcelCellValue): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectColumnStats(
  header: ExecutiveMasterExcelHeader,
  rows: ExecutiveMasterSheetPgRow[]
) {
  const counts = new Map<string, { label: string; count: number }>();
  let nonNull = 0;
  let dateLike = 0;
  let totalLength = 0;

  for (const row of rows) {
    const raw = row[header];
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

export function discoverExecutiveMasterSheetFilters(
  rows: ExecutiveMasterSheetPgRow[]
): ExecutiveMasterFilterField[] {
  const fields: ExecutiveMasterFilterField[] = [];

  for (const header of EXECUTIVE_MASTER_EXCEL_HEADERS) {
    const stats = collectColumnStats(header, rows);
    const isJobStatus = header === "Job Status";
    const isJobDescription = isExecutiveJobDescriptionColumn(header);
    const isMustHave = isExecutiveMustHaveSkillsColumn(header);

    let control: ExecutiveFilterControl | null = isJobStatus
      ? "multi-select"
      : isJobDescription || isMustHave
        ? "text"
        : inferExecutiveFilterControl(header, stats);

    // Every one of the 13 real columns is filterable, even if the heuristic
    // above declines (e.g. all-null "Date" today) — mirrors the "always
    // expose a filter for every live column" rule the Excel-backed engine used.
    if (!control) {
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

export function applyExecutiveMasterSheetFilters(
  rows: ExecutiveMasterSheetPgRow[],
  query: Pick<
    ExecutiveMasterSheetQuery,
    "columnFilters" | "textFilters" | "dateFilters"
  >
): ExecutiveMasterSheetPgRow[] {
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
        asText(row[column as ExecutiveMasterExcelHeader])
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
          row[column as ExecutiveMasterExcelHeader],
          needle
        )
      ) {
        return false;
      }
    }

    for (const [column, range] of dateEntries) {
      const cellDate = parseCellDate(row[column as ExecutiveMasterExcelHeader]);
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

export async function getExecutiveMasterSheetSchema(
  sqlClient?: SqlClient
): Promise<ExecutiveMasterSheetSchema> {
  const rows = await loadRows(sqlClient);
  return {
    sheetName: EXECUTIVE_MASTER_SHEET_PG_NAME,
    sourceFile: EXECUTIVE_MASTER_PG_SOURCE_FILE,
    sourceKind: "postgres",
    headers: [...EXECUTIVE_MASTER_EXCEL_HEADERS],
    fields: discoverExecutiveMasterSheetFilters(rows),
  };
}

export async function queryExecutiveMasterSheetPage(
  query: ExecutiveMasterSheetQuery,
  sqlClient?: SqlClient
): Promise<ExecutiveMasterSheetPageResult> {
  const rows = await loadRows(sqlClient);
  const filtered = applyExecutiveMasterSheetFilters(rows, query);
  const page = paginateExecutiveRows(filtered, query.page, query.pageSize);

  return {
    sheetName: EXECUTIVE_MASTER_SHEET_PG_NAME,
    sourceFile: EXECUTIVE_MASTER_PG_SOURCE_FILE,
    sourceKind: "postgres",
    headers: [...EXECUTIVE_MASTER_EXCEL_HEADERS],
    rows: page.rows,
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
    pageCount: page.pageCount,
  };
}

/**
 * Full, unfiltered table for export — mirrors Lateral's export policy
 * (ignore active UI filters, return everything).
 */
export async function exportExecutiveMasterSheetRows(
  sqlClient?: SqlClient
): Promise<{
  rows: ExecutiveMasterSheetPgRow[];
  headers: string[];
  sheetName: string;
}> {
  const rows = await loadRows(sqlClient);
  return {
    rows,
    headers: [...EXECUTIVE_MASTER_EXCEL_HEADERS],
    sheetName: EXECUTIVE_MASTER_SHEET_PG_NAME,
  };
}
