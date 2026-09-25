import type postgres from "postgres";
import {
  listCandidateMasterRows,
  type CandidateMasterRow,
} from "@/services/persistence/read-candidate-master";
import {
  CANDIDATE_MASTER_COLUMN_MAP,
  CANDIDATE_MASTER_EXCEL_HEADERS,
  CANDIDATE_MASTER_PG_SOURCE_FILE,
  excelHeaderForCandidateDbColumn,
  type CandidateMasterExcelHeader,
  type CandidateMasterSheetDbColumn,
} from "@/services/persistence/candidate-master-sheet-columns";
import {
  getLatestCandidateChangedFields,
  getLatestCandidateReviewFlags,
  type CandidateChangedFieldsByCid,
  type CandidateReviewFlagRow,
} from "@/services/persistence/read-candidate-highlights";
import { getCandidateCidsTouchedBySync } from "@/services/persistence/read-candidate-sync-history";
import {
  isCandidateRoleNameColumn,
  type CandidateFilterControl,
  type CandidateHighlightFilterValue,
  type CandidateMasterDateFilter,
  type CandidateMasterFilterField,
  type CandidateMasterPageSize,
} from "@/services/excel/candidate-master-sheet";

/**
 * Read-only in-memory filter/paginate engine for the Candidate Master Sheet
 * page, sourced from PostgreSQL `candidate_master` (16 display columns).
 *
 * No `import "server-only"` — same reasoning as read-candidate-master.ts:
 * this module is imported directly by standalone tsx verify scripts
 * (scripts/verify-candidate-highlights.ts), which never run inside Next's
 * bundler where "server-only" resolves. Every current client-side consumer
 * (candidate-master-sheet-table.tsx, candidate-flag-detail-modal.tsx,
 * use-candidate-master-sheet.ts) already uses `import type` for anything it
 * pulls from here, so this file's runtime code is never actually bundled
 * client-side regardless.
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
  /** Not a display column — internal only, used by the "filter by sync" predicate below. */
  insertedSyncId: number | null;
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
  highlightFilters?: CandidateHighlightFilterValue[];
  /** candidate_sync_history.id — narrows to rows that sync inserted, updated, or flagged. */
  syncFilter?: number | null;
}

/** One open per-field review flag, resolved to a display header (C9 highlighting). */
export interface CandidateFieldFlag {
  header: CandidateMasterExcelHeader;
  reason: string;
  detail: Record<string, unknown>;
}

/**
 * C9 highlight state for the rows on the current page only — reason: 1)
 * green (changedCellsByCid) and amber (fieldFlagsByCid) highlights are
 * "most recent per issue" snapshots of small, purpose-built audit tables
 * (candidate_sync_changes / candidate_review_flags), unlike the ~12k-row
 * candidate_master table itself, and 2) there's no reason to ship the whole
 * dataset's highlight state to the client on every page load when only the
 * visible page's rows can render it.
 */
export interface CandidateMasterSheetHighlights {
  /** CID -> display headers changed in the most recent sync that touched that CID. */
  changedCellsByCid: Record<string, CandidateMasterExcelHeader[]>;
  /** CID -> open row-level flag reason (duplicate_name_mismatch / invalid_candidate_id). */
  duplicateFlagCids: Record<string, "duplicate_name_mismatch" | "invalid_candidate_id">;
  /** CID -> open per-field flags (jr_id_conflict / unclean_contact_number / legacy_contact_number_unclean / missing_job_requisition_id). */
  fieldFlagsByCid: Record<string, CandidateFieldFlag[]>;
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
  highlights: CandidateMasterSheetHighlights;
}

function toSheetRow(row: CandidateMasterRow): CandidateMasterSheetPgRow {
  const next = {
    id: String(row.id),
    insertedSyncId: row.inserted_sync_id,
  } as CandidateMasterSheetPgRow;
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

/** Resolves a per-field review flag's field to a display header. See candidate-sync-engine.ts for exact `detail` shapes per reason. */
function fieldFlagHeader(flag: CandidateReviewFlagRow): CandidateMasterExcelHeader | null {
  if (flag.reason === "unclean_contact_number" || flag.reason === "legacy_contact_number_unclean") {
    return "Contact Number";
  }
  if (flag.reason === "missing_job_requisition_id") {
    return excelHeaderForCandidateDbColumn("job_requisition_id");
  }
  if (flag.reason === "jr_id_conflict") {
    const field = flag.detail.field;
    if (typeof field !== "string") return null;
    try {
      return excelHeaderForCandidateDbColumn(field as CandidateMasterSheetDbColumn);
    } catch {
      return null;
    }
  }
  // duplicate_name_mismatch / invalid_candidate_id are row-level flags, not per-field ones.
  return null;
}

/** Builds the page-scoped display highlight state from already-fetched, full-table highlight data (see queryCandidateMasterSheetPage — fetched once and shared with the highlight-filter predicate). */
function buildHighlightState(
  cidsOnPage: string[],
  changedFields: CandidateChangedFieldsByCid,
  reviewFlags: CandidateReviewFlagRow[]
): CandidateMasterSheetHighlights {
  const cidSet = new Set(cidsOnPage);

  const changedCellsByCid: Record<string, CandidateMasterExcelHeader[]> = {};
  for (const cid of cidsOnPage) {
    const fields = changedFields.get(cid);
    if (!fields || fields.size === 0) continue;
    const headers: CandidateMasterExcelHeader[] = [];
    for (const field of fields) {
      try {
        headers.push(excelHeaderForCandidateDbColumn(field as CandidateMasterSheetDbColumn));
      } catch {
        // field_name isn't a displayed column (shouldn't happen post-C1 — every
        // diffable field now has a header — but never let a stray value break the page).
      }
    }
    if (headers.length > 0) changedCellsByCid[cid] = headers;
  }

  const duplicateFlagCids: Record<string, "duplicate_name_mismatch" | "invalid_candidate_id"> = {};
  const fieldFlagsByCid: Record<string, CandidateFieldFlag[]> = {};
  for (const flag of reviewFlags) {
    if (!cidSet.has(flag.cid)) continue;
    if (flag.reason === "duplicate_name_mismatch" || flag.reason === "invalid_candidate_id") {
      duplicateFlagCids[flag.cid] = flag.reason;
      continue;
    }
    const header = fieldFlagHeader(flag);
    if (!header) continue;
    const list = fieldFlagsByCid[flag.cid] ?? [];
    list.push({ header, reason: flag.reason, detail: flag.detail });
    fieldFlagsByCid[flag.cid] = list;
  }

  return {
    changedCellsByCid,
    duplicateFlagCids,
    fieldFlagsByCid,
  };
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
  if (/^date\b|upload date|submitted date/i.test(header)) return "date";
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
  query: Pick<
    CandidateMasterSheetQuery,
    "columnFilters" | "textFilters" | "dateFilters" | "highlightFilters" | "syncFilter"
  >,
  highlightData?: {
    changedFields: CandidateChangedFieldsByCid;
    reviewFlags: CandidateReviewFlagRow[];
  },
  /** CIDs updated/flagged by `query.syncFilter` (see getCandidateCidsTouchedBySync) — inserts are checked directly via each row's own `insertedSyncId` instead. */
  syncFilterCids?: Set<string> | null
): CandidateMasterSheetPgRow[] {
  const columnEntries = Object.entries(query.columnFilters).filter(([, v]) => v.length > 0);
  const textEntries = Object.entries(query.textFilters).filter(([, v]) => v.trim().length > 0);
  const dateEntries = Object.entries(query.dateFilters).filter(
    ([, r]) => Boolean(r.from || r.to)
  );
  const highlightFilters = query.highlightFilters ?? [];
  const syncFilter = query.syncFilter ?? null;

  if (
    columnEntries.length === 0 &&
    textEntries.length === 0 &&
    dateEntries.length === 0 &&
    highlightFilters.length === 0 &&
    syncFilter === null
  ) {
    return rows;
  }

  // OR within the selected highlight types, same as multi-select within one column filter.
  let highlightMatchCids: Set<string> | null = null;
  if (highlightFilters.length > 0 && highlightData) {
    highlightMatchCids = new Set<string>();
    if (highlightFilters.includes("changed")) {
      for (const cid of highlightData.changedFields.keys()) highlightMatchCids.add(cid);
    }
    const reasonFilters = new Set(highlightFilters.filter((value) => value !== "changed"));
    if (reasonFilters.size > 0) {
      for (const flag of highlightData.reviewFlags) {
        if (reasonFilters.has(flag.reason)) highlightMatchCids.add(flag.cid);
      }
    }
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

    if (highlightMatchCids && !highlightMatchCids.has(row["Candidate ID"])) return false;

    if (syncFilter !== null) {
      const insertedByThisSync = row.insertedSyncId === syncFilter;
      const touchedByThisSync = syncFilterCids?.has(row["Candidate ID"]) ?? false;
      if (!insertedByThisSync && !touchedByThisSync) return false;
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
  // Fetched once, full-table (both queries are already unfiltered — see
  // read-candidate-highlights.ts), and shared between the highlight-filter
  // predicate (needs full-table coverage, pre-pagination) and the page's
  // display highlight state (page-scoped, post-pagination) below — avoids
  // querying candidate_sync_changes/candidate_review_flags twice per request.
  const [changedFields, reviewFlags, syncFilterCids] = await Promise.all([
    getLatestCandidateChangedFields(sqlClient),
    getLatestCandidateReviewFlags(sqlClient),
    query.syncFilter != null
      ? getCandidateCidsTouchedBySync(query.syncFilter, sqlClient)
      : Promise.resolve(null),
  ]);
  const filtered = applyCandidateMasterSheetFilters(
    rows,
    query,
    { changedFields, reviewFlags },
    syncFilterCids
  );
  const page = paginate(filtered, query.page, query.pageSize);
  const highlights = buildHighlightState(
    page.rows.map((row) => row["Candidate ID"]),
    changedFields,
    reviewFlags
  );

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
    highlights,
  };
}
