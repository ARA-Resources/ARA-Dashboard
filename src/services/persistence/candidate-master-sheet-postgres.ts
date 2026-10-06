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
  getCandidateCidsInsertedInWindow,
  getCandidateRecentChangeWindowSyncIds,
  getLatestCandidateChangedFields,
  getLatestCandidateReviewFlags,
  type CandidateChangedFieldsByCid,
  type CandidateReviewFlagRow,
} from "@/services/persistence/read-candidate-highlights";
import {
  getAccentureChangedFieldsForRun,
  getAccentureHoverData,
  getAccentureUploadSyncIds,
  getCidsInsertedByRun,
  getLatestSuccessfulAccentureRun,
  type CandidateAccentureHoverEntry,
} from "@/services/persistence/read-candidate-accenture-highlights";
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
  /**
   * Not a display column — migration 022, threaded through now (Stage 1,
   * same shape as insertedSyncId above) so Stage 3's highlight/filter logic
   * can consume it without further plumbing. The two Accenture lock
   * booleans are deliberately NOT projected onto this UI-facing row type —
   * they're not string|number|null, which this type's export path
   * (ExcelDataRow) requires, and nothing reads them from here; Stage 2's
   * engine reads them directly off CandidateMasterRow instead. Never
   * rendered, never accepted from Add/Modify.
   */
  lastAccentureSyncId: number | null;
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
  /** CID -> every open row-level flag reason (duplicate_name_mismatch / invalid_candidate_id / duplicate_cid) — an array, not a single value, since one CID can carry more than one of these simultaneously (e.g. a duplicate_cid group whose names also mismatch). */
  duplicateFlagCids: Record<string, ("duplicate_name_mismatch" | "invalid_candidate_id" | "duplicate_cid")[]>;
  /** CID -> open per-field flags (jr_id_conflict / unclean_contact_number / legacy_contact_number_unclean / missing_job_requisition_id). */
  fieldFlagsByCid: Record<string, CandidateFieldFlag[]>;
  /** Stage 3 — violet: cells touched (or, for Name, still-unresolved-mismatch-noted) by the single latest SUCCESSFUL Accenture run. Independent of changedCellsByCid/the Oorwin window. */
  accentureCellsByCid: Record<string, CandidateMasterExcelHeader[]>;
  /** Stage 3 — CIDs (of the current page) inserted by the latest successful Accenture run, for the Candidate ID cell's violet tint. */
  accentureInsertedCids: string[];
  /** Stage 3 — rich hover data for the 5 Accenture-synced fields + Name, page-scoped. */
  accentureHoverByCid: Record<string, Record<string, CandidateAccentureHoverEntry>>;
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
    lastAccentureSyncId: row.last_accenture_sync_id,
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

/**
 * Live CIDs (of LIVE, non-soft-deleted rows) currently appearing on more
 * than one row — migration 021 (D2): the "Duplicate CID" highlight is
 * derived from the table's actual current state, computed from the same
 * `rows` array `loadRows` already returned, rather than from a stored
 * `candidate_review_flags` reason. A stored flag is written once and never
 * cleared, so it goes stale the moment a duplicate is resolved by a Delete,
 * or a new one is created by an Add — a live computation can't go stale.
 * (The Oorwin sync engine still writes a `duplicate_cid` review flag when it
 * quarantines an ambiguous-CID row — that stays as an audit record, it's
 * just no longer what drives this specific highlight.)
 */
function computeLiveDuplicateCids(rows: CandidateMasterSheetPgRow[]): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const cid = row["Candidate ID"];
    if (!cid || cid === "-") continue;
    counts.set(cid, (counts.get(cid) ?? 0) + 1);
  }
  const duplicates = new Set<string>();
  for (const [cid, count] of counts) {
    if (count > 1) duplicates.add(cid);
  }
  return duplicates;
}

/** Resolves a per-field review flag's field to a display header. See candidate-sync-engine.ts for exact `detail` shapes per reason. */
function fieldFlagHeader(flag: CandidateReviewFlagRow): CandidateMasterExcelHeader | null {
  if (flag.reason === "unclean_contact_number" || flag.reason === "legacy_contact_number_unclean") {
    return "Contact Number";
  }
  if (flag.reason === "unclear_gender") {
    return "Gender";
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
  // duplicate_name_mismatch / invalid_candidate_id / duplicate_cid are row-level flags, not per-field ones.
  return null;
}

/** Builds the page-scoped display highlight state from already-fetched, full-table highlight data (see queryCandidateMasterSheetPage — fetched once and shared with the highlight-filter predicate). */
function buildHighlightState(
  cidsOnPage: string[],
  changedFields: CandidateChangedFieldsByCid,
  reviewFlags: CandidateReviewFlagRow[],
  liveDuplicateCids: Set<string>,
  accentureState: {
    accentureCellsByCid: Record<string, CandidateMasterExcelHeader[]>;
    accentureInsertedCids: string[];
    accentureHoverByCid: Record<string, Record<string, CandidateAccentureHoverEntry>>;
  }
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

  // duplicate_cid is intentionally NOT read from reviewFlags here — see
  // computeLiveDuplicateCids's doc comment (migration 021, D2).
  const duplicateFlagCids: Record<string, ("duplicate_name_mismatch" | "invalid_candidate_id" | "duplicate_cid")[]> = {};
  const fieldFlagsByCid: Record<string, CandidateFieldFlag[]> = {};
  for (const flag of reviewFlags) {
    if (!cidSet.has(flag.cid)) continue;
    if (flag.reason === "duplicate_name_mismatch" || flag.reason === "invalid_candidate_id") {
      const list = duplicateFlagCids[flag.cid] ?? [];
      if (!list.includes(flag.reason)) list.push(flag.reason);
      duplicateFlagCids[flag.cid] = list;
      continue;
    }
    if (flag.reason === "duplicate_cid") continue; // audit-only now; the live highlight below is authoritative
    const header = fieldFlagHeader(flag);
    if (!header) continue;
    const list = fieldFlagsByCid[flag.cid] ?? [];
    list.push({ header, reason: flag.reason, detail: flag.detail });
    fieldFlagsByCid[flag.cid] = list;
  }

  for (const cid of cidsOnPage) {
    if (!liveDuplicateCids.has(cid)) continue;
    const list = duplicateFlagCids[cid] ?? [];
    if (!list.includes("duplicate_cid")) list.push("duplicate_cid");
    duplicateFlagCids[cid] = list;
  }

  return {
    changedCellsByCid,
    duplicateFlagCids,
    fieldFlagsByCid,
    accentureCellsByCid: accentureState.accentureCellsByCid,
    accentureInsertedCids: accentureState.accentureInsertedCids,
    accentureHoverByCid: accentureState.accentureHoverByCid,
  };
}

/**
 * Stage 3 — page-scoped violet highlight cells + hover data, built from the
 * latest successful Accenture run alone (not a window). Every one of the 6
 * tracked fields (the 5 synced fields + Name) gets the SAME staleness check
 * the hover already computes per-field: a field only stays in the violet
 * set if the Accenture run is still the most recent WRITER of that exact
 * cell (`isAccentureLatest`) — if a later write (a manual correction, or an
 * Oorwin sync for a field it also touches) is now the most recent word on
 * this CID's field, the cell drops out of the violet set entirely, same as
 * the hover already reverts to plain for it. (Previously this staleness
 * check was applied to Name only; the other 5 fields used a plain snapshot
 * of what the latest run touched, with no check that Accenture was still
 * the latest writer — fixed here, not a new query, since `hoverData` below
 * already carries `isAccentureLatest` for all 6 fields.) This is unrelated
 * to `accentureInsertedCids` (the Candidate ID tint for a row the latest
 * run INSERTED) — that one is permanent-by-design and untouched by this
 * check.
 */
async function loadAccentureHighlightState(
  cidsOnPage: string[],
  latestSuccessfulSyncId: number | null,
  sqlClient?: SqlClient
): Promise<{
  accentureCellsByCid: Record<string, CandidateMasterExcelHeader[]>;
  accentureInsertedCids: string[];
  accentureHoverByCid: Record<string, Record<string, CandidateAccentureHoverEntry>>;
}> {
  if (latestSuccessfulSyncId === null || cidsOnPage.length === 0) {
    return { accentureCellsByCid: {}, accentureInsertedCids: [], accentureHoverByCid: {} };
  }

  const [changedFields, insertedCids, hoverData] = await Promise.all([
    getAccentureChangedFieldsForRun(latestSuccessfulSyncId, sqlClient),
    getCidsInsertedByRun(latestSuccessfulSyncId, sqlClient),
    getAccentureHoverData(cidsOnPage, sqlClient),
  ]);

  const accentureCellsByCid: Record<string, CandidateMasterExcelHeader[]> = {};
  for (const cid of cidsOnPage) {
    const fields = changedFields.get(cid);
    if (!fields || fields.size === 0) continue;
    const headers: CandidateMasterExcelHeader[] = [];
    for (const field of fields) {
      // A later write (manual edit, or Oorwin for a field it also touches)
      // is now the latest word on this exact cell — don't show violet.
      if (!hoverData.get(cid)?.get(field)?.isAccentureLatest) continue;
      if (field === "name") {
        headers.push("Name");
        continue;
      }
      try {
        headers.push(excelHeaderForCandidateDbColumn(field as CandidateMasterSheetDbColumn));
      } catch {
        // stray field_name — ignore rather than crash the page.
      }
    }
    if (headers.length > 0) accentureCellsByCid[cid] = headers;
  }

  const cidsOnPageSet = new Set(cidsOnPage);
  const accentureHoverByCid: Record<string, Record<string, CandidateAccentureHoverEntry>> = {};
  for (const [cid, byField] of hoverData) {
    if (!cidsOnPageSet.has(cid)) continue;
    const obj: Record<string, CandidateAccentureHoverEntry> = {};
    for (const [field, entry] of byField) {
      const header =
        field === "name"
          ? "Name"
          : (() => {
              try {
                return excelHeaderForCandidateDbColumn(field as CandidateMasterSheetDbColumn);
              } catch {
                return null;
              }
            })();
      if (header) obj[header] = entry;
    }
    accentureHoverByCid[cid] = obj;
  }

  return {
    accentureCellsByCid,
    accentureInsertedCids: [...insertedCids].filter((cid) => cidsOnPageSet.has(cid)),
    accentureHoverByCid,
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

/**
 * Migration 022 renamed the "Status" display header to "Oorwin Candidate
 * Stage" (dbColumn unchanged). A bookmarked URL, a saved filter, or any API
 * caller still sending the old column key "Status" would otherwise silently
 * match zero rows (row["Status"] is undefined on the renamed row shape) —
 * exported so a test can assert the alias directly.
 */
export function normalizeLegacyCandidateFilterKey(column: string): string {
  return column === "Status" ? "Oorwin Candidate Stage" : column;
}

export function applyCandidateMasterSheetFilters(
  rows: CandidateMasterSheetPgRow[],
  query: Pick<
    CandidateMasterSheetQuery,
    "columnFilters" | "textFilters" | "dateFilters" | "highlightFilters" | "syncFilter"
  >,
  highlightData?: {
    /** Already enriched with inserted-in-window CIDs by the caller — see queryCandidateMasterSheetPage. */
    changedFields: CandidateChangedFieldsByCid;
    reviewFlags: CandidateReviewFlagRow[];
    /** Live CIDs currently duplicated (migration 021, D2) — see computeLiveDuplicateCids. */
    liveDuplicateCids: Set<string>;
    /** Stage 3 — every candidate_sync_history id ever stamped kind='accenture_upload' (non-failed) — backs the permanent "New Rows" filter. */
    accentureUploadSyncIds?: Set<number>;
    /** Stage 3 — the latest successful Accenture run's id — backs the "Latest Upload" filter. */
    latestSuccessfulAccentureSyncId?: number | null;
  },
  /** CIDs updated/flagged by `query.syncFilter` (see getCandidateCidsTouchedBySync) — inserts are checked directly via each row's own `insertedSyncId` instead. */
  syncFilterCids?: Set<string> | null
): CandidateMasterSheetPgRow[] {
  const columnEntries = Object.entries(query.columnFilters)
    .map(([column, v]) => [normalizeLegacyCandidateFilterKey(column), v] as const)
    .filter(([, v]) => v.length > 0);
  const textEntries = Object.entries(query.textFilters)
    .map(([column, v]) => [normalizeLegacyCandidateFilterKey(column), v] as const)
    .filter(([, v]) => v.trim().length > 0);
  const dateEntries = Object.entries(query.dateFilters)
    .map(([column, r]) => [normalizeLegacyCandidateFilterKey(column), r] as const)
    .filter(([, r]) => Boolean(r.from || r.to));
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
    if (highlightFilters.includes("duplicate_cid")) {
      for (const cid of highlightData.liveDuplicateCids) highlightMatchCids.add(cid);
    }
    if (highlightFilters.includes("accenture_touched")) {
      for (const row of rows) {
        if (row.lastAccentureSyncId !== null) highlightMatchCids.add(row["Candidate ID"]);
      }
    }
    if (highlightFilters.includes("accenture_new_rows") && highlightData.accentureUploadSyncIds) {
      for (const row of rows) {
        if (
          row.insertedSyncId !== null &&
          highlightData.accentureUploadSyncIds.has(row.insertedSyncId)
        ) {
          highlightMatchCids.add(row["Candidate ID"]);
        }
      }
    }
    if (
      highlightFilters.includes("accenture_latest_upload") &&
      highlightData.latestSuccessfulAccentureSyncId != null
    ) {
      for (const row of rows) {
        if (row.lastAccentureSyncId === highlightData.latestSuccessfulAccentureSyncId) {
          highlightMatchCids.add(row["Candidate ID"]);
        }
      }
    }
    // Explicit generic: TS's inferred-predicate narrowing on the .filter()
    // below would otherwise narrow this Set's element type to exclude
    // "duplicate_cid" (since it's filtered out) — fine at runtime (a flag
    // with that reason just never matches, exactly as intended, handled
    // separately above), but it makes `.has(flag.reason)` below reject the
    // full CandidateReviewFlagReason union as a type error.
    const reasonFilters = new Set<CandidateHighlightFilterValue>(
      highlightFilters.filter((value) => value !== "changed" && value !== "duplicate_cid")
    );
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

/**
 * Fetches and assembles everything `queryCandidateMasterSheetPage` and
 * `exportCandidateMasterSheetRows` both need from the highlight tables, in
 * one place so the two stay in sync. `changedFields` comes back already
 * enriched with any CID inserted within the "Recently changed" window that
 * has no candidate_sync_changes rows of its own (an Oorwin insert — see
 * getCandidateCidsInsertedInWindow's doc comment) by marking every
 * displayed column "changed" for that CID, so a brand-new row shows fully
 * highlighted rather than not at all.
 */
async function loadCandidateHighlightData(
  rows: CandidateMasterSheetPgRow[],
  sqlClient?: SqlClient
): Promise<{
  changedFields: CandidateChangedFieldsByCid;
  reviewFlags: CandidateReviewFlagRow[];
  liveDuplicateCids: Set<string>;
  accentureUploadSyncIds: Set<number>;
  latestSuccessfulAccentureSyncId: number | null;
}> {
  const windowSyncIds = await getCandidateRecentChangeWindowSyncIds(sqlClient);
  const [changedFields, insertedCids, reviewFlags, accentureUploadSyncIds, latestAccentureRun] =
    await Promise.all([
      getLatestCandidateChangedFields(windowSyncIds, sqlClient),
      getCandidateCidsInsertedInWindow(windowSyncIds, sqlClient),
      getLatestCandidateReviewFlags(sqlClient),
      getAccentureUploadSyncIds(sqlClient),
      getLatestSuccessfulAccentureRun(sqlClient),
    ]);
  for (const cid of insertedCids) {
    if (!changedFields.has(cid)) {
      changedFields.set(cid, new Set(CANDIDATE_MASTER_COLUMN_MAP.map((m) => m.dbColumn)));
    }
  }
  const liveDuplicateCids = computeLiveDuplicateCids(rows);
  return {
    changedFields,
    reviewFlags,
    liveDuplicateCids,
    accentureUploadSyncIds,
    latestSuccessfulAccentureSyncId: latestAccentureRun?.id ?? null,
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
  // Fetched once, full-table, and shared between the highlight-filter
  // predicate (needs full-table coverage, pre-pagination) and the page's
  // display highlight state (page-scoped, post-pagination) below — avoids
  // querying the highlight tables twice per request.
  const [
    { changedFields, reviewFlags, liveDuplicateCids, accentureUploadSyncIds, latestSuccessfulAccentureSyncId },
    syncFilterCids,
  ] = await Promise.all([
    loadCandidateHighlightData(rows, sqlClient),
    query.syncFilter != null
      ? getCandidateCidsTouchedBySync(query.syncFilter, sqlClient)
      : Promise.resolve(null),
  ]);
  const filtered = applyCandidateMasterSheetFilters(
    rows,
    query,
    {
      changedFields,
      reviewFlags,
      liveDuplicateCids,
      accentureUploadSyncIds,
      latestSuccessfulAccentureSyncId,
    },
    syncFilterCids
  );
  const page = paginate(filtered, query.page, query.pageSize);
  const pageCids = page.rows.map((row) => row["Candidate ID"]);
  const accentureState = await loadAccentureHighlightState(
    pageCids,
    latestSuccessfulAccentureSyncId,
    sqlClient
  );
  const highlights = buildHighlightState(
    pageCids,
    changedFields,
    reviewFlags,
    liveDuplicateCids,
    accentureState
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

/**
 * Table for export, respecting the same columnFilters/textFilters/dateFilters/
 * highlightFilters/syncFilter the on-screen table applies (via
 * applyCandidateMasterSheetFilters) — an unfiltered query returns the full
 * table.
 */
export async function exportCandidateMasterSheetRows(
  query: Pick<
    CandidateMasterSheetQuery,
    "columnFilters" | "textFilters" | "dateFilters" | "highlightFilters" | "syncFilter"
  >,
  sqlClient?: SqlClient
): Promise<{
  rows: CandidateMasterSheetPgRow[];
  headers: string[];
  sheetName: string;
}> {
  const rows = await loadRows(sqlClient);
  const [
    { changedFields, reviewFlags, liveDuplicateCids, accentureUploadSyncIds, latestSuccessfulAccentureSyncId },
    syncFilterCids,
  ] = await Promise.all([
    loadCandidateHighlightData(rows, sqlClient),
    query.syncFilter != null
      ? getCandidateCidsTouchedBySync(query.syncFilter, sqlClient)
      : Promise.resolve(null),
  ]);
  const filtered = applyCandidateMasterSheetFilters(
    rows,
    query,
    {
      changedFields,
      reviewFlags,
      liveDuplicateCids,
      accentureUploadSyncIds,
      latestSuccessfulAccentureSyncId,
    },
    syncFilterCids
  );

  return {
    rows: filtered,
    headers: [...CANDIDATE_MASTER_EXCEL_HEADERS],
    sheetName: CANDIDATE_MASTER_SHEET_PG_NAME,
  };
}
