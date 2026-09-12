/**
 * Confirmed Base DS → executive_master column mapping (Phase E3).
 *
 * Source: real "ATCI Exec DS_*.xlsx" files (7th/8th/9th Sept 2026), Base DS tab.
 * Supersedes the abandoned `src/services/dataset/executive-dataset-mapping.ts`
 * (that file mapped Base DS → a Google Sheets "New Sheet" destination — a
 * different, superseded architecture; left untouched for Phase E7 cleanup).
 *
 * Header matching philosophy (same as Lateral): exact → case-insensitive →
 * normalized (strip everything but letters/digits, lowercase), to tolerate
 * future header casing/spacing variance without silently mismatching columns.
 */

export const EXECUTIVE_BASE_DS_SHEET_NAME = "Base DS" as const;

/** executive_master business columns populated from the Base DS. */
export const EXECUTIVE_MASTER_UPSERT_FIELDS = [
  "market_map",
  "primary_skills",
  "job_management_level",
  "skill_categorization",
  "primary_location",
  "must_have_skills",
  "location_flex",
  "job_description",
  "priority",
] as const;

export type ExecutiveMasterUpsertField =
  (typeof EXECUTIVE_MASTER_UPSERT_FIELDS)[number];

/**
 * Confirmed Base DS headers for every field EXCEPT Market Map, which has its
 * own dedicated resolution rule (see {@link resolveExecutiveMarketMapColumn}).
 */
const EXECUTIVE_BASE_DS_HEADER_ALIASES: Record<
  Exclude<ExecutiveMasterUpsertField, "market_map">,
  string
> = {
  primary_skills: "Primary Skills",
  job_management_level: "Job Management Level",
  skill_categorization: "Skill Categorization",
  primary_location: "Primary Location",
  must_have_skills: "Mandatory skill",
  location_flex: "Location Flex",
  job_description: "Job Description",
  priority: "Priority given to agency",
};

export const EXECUTIVE_BASE_DS_JR_HEADER = "Job Requisition ID";

export function normalizeExecutiveHeaderKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * exact → case-insensitive → normalized, in that order. Never matches by
 * column position.
 */
export function findExecutiveHeaderIndex(
  headers: string[],
  wanted: string
): number {
  let idx = headers.findIndex((h) => h === wanted);
  if (idx >= 0) return idx;
  idx = headers.findIndex(
    (h) => h.toLowerCase() === wanted.toLowerCase()
  );
  if (idx >= 0) return idx;
  const normWanted = normalizeExecutiveHeaderKey(wanted);
  idx = headers.findIndex(
    (h) => normalizeExecutiveHeaderKey(h) === normWanted
  );
  return idx;
}

export interface ExecutiveMarketMapResolution {
  /** Column index to read Market Map from, or -1 if neither form is present. */
  index: number;
  /** Which form was used. "none" when neither is present. */
  source: "new" | "plain" | "none";
  /** True when the file also has a "(Old)" column — confirmed to be ignored. */
  oldColumnPresent: boolean;
}

/**
 * Market Map resolution rule (confirmed):
 * - When both "Final Market Map (Old)" and "(New)" columns exist, use ONLY (New).
 * - When only the single "Final Market Map" column exists (older file format,
 *   e.g. the 7th Sept file), use that.
 * - NEVER use "(Old)".
 */
export function resolveExecutiveMarketMapColumn(
  headers: string[]
): ExecutiveMarketMapResolution {
  const newIdx = findExecutiveHeaderIndex(headers, "Final Market Map (New)");
  const oldIdx = findExecutiveHeaderIndex(headers, "Final Market Map (Old)");
  const oldColumnPresent = oldIdx >= 0;

  if (newIdx >= 0) {
    return { index: newIdx, source: "new", oldColumnPresent };
  }

  // Plain "Final Market Map" — must NOT accidentally match the Old/New
  // variants (findExecutiveHeaderIndex's normalized pass strips spaces and
  // punctuation, so "Final Market Map" alone would never equal the
  // normalized form of "Final Market Map (Old)"/"(New)" — those normalize to
  // "finalmarketmapold"/"finalmarketmapnew", distinct from "finalmarketmap").
  const plainIdx = findExecutiveHeaderIndex(headers, "Final Market Map");
  if (plainIdx >= 0 && plainIdx !== oldIdx && plainIdx !== newIdx) {
    return { index: plainIdx, source: "plain", oldColumnPresent };
  }

  return { index: -1, source: "none", oldColumnPresent };
}

/**
 * Confirmed Excel error codes (calculated-value form). Real `#REF!` errors
 * were found in "Mandatory skill" / "Location Flex" in the demand sheet
 * (broken external-link formulas) — this check is not restricted to those
 * two columns since the underlying rule is about calculated-value cells in
 * general, not a specific column list.
 */
const KNOWN_EXCEL_ERROR_CODES = [
  "#REF!",
  "#N/A",
  "#VALUE!",
  "#DIV/0!",
  "#NAME?",
  "#NULL!",
] as const;

/** Generic fallback for any other Excel error shape (e.g. #GETTING_DATA, #SPILL!). */
const GENERIC_EXCEL_ERROR_PATTERN = /^#[A-Z0-9_/]+[!?]?$/;

/**
 * Detect whether a calculated cell value is an Excel error code.
 * Returns the error code string when it is, otherwise null.
 * Never inspects the formula — caller must already be passing the
 * *calculated* value (e.g. openpyxl `data_only=True`), never the formula text.
 */
export function classifyExecutiveExcelError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if ((KNOWN_EXCEL_ERROR_CODES as readonly string[]).includes(trimmed)) {
    return trimmed;
  }
  if (GENERIC_EXCEL_ERROR_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function normalizeExecutiveCellText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/ /g, " ").replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

export interface ExecutiveBaseDsHeaderIndex {
  jobRequisitionId: number;
  marketMap: ExecutiveMarketMapResolution;
  fields: Partial<Record<Exclude<ExecutiveMasterUpsertField, "market_map">, number>>;
  /** Confirmed columns entirely absent from this file's header row. */
  missingHeaders: string[];
}

/**
 * Resolve every confirmed column's index from an actual header row.
 * Job Requisition ID is mandatory (it's the reconcile key) — every other
 * confirmed column is best-effort: if a future export drops or renames one,
 * we log it as missing and store NULL for that field rather than aborting
 * the whole run (header matching is exact → case-insensitive → normalized,
 * so ordinary casing/spacing drift is already tolerated before this point).
 */
export function resolveExecutiveBaseDsHeaderIndex(
  headers: string[]
): ExecutiveBaseDsHeaderIndex {
  const jobRequisitionId = findExecutiveHeaderIndex(
    headers,
    EXECUTIVE_BASE_DS_JR_HEADER
  );
  const marketMap = resolveExecutiveMarketMapColumn(headers);

  const fields: ExecutiveBaseDsHeaderIndex["fields"] = {};
  const missingHeaders: string[] = [];

  if (marketMap.source === "none") {
    missingHeaders.push("Final Market Map (New) / Final Market Map");
  }

  for (const [field, header] of Object.entries(
    EXECUTIVE_BASE_DS_HEADER_ALIASES
  ) as Array<
    [Exclude<ExecutiveMasterUpsertField, "market_map">, string]
  >) {
    const idx = findExecutiveHeaderIndex(headers, header);
    if (idx >= 0) {
      fields[field] = idx;
    } else {
      missingHeaders.push(header);
    }
  }

  return { jobRequisitionId, marketMap, fields, missingHeaders };
}

export interface ExecutiveMappedRowError {
  column: string;
  errorType: string;
}

export interface ExecutiveMappedRow {
  jobRequisitionId: string;
  values: Record<ExecutiveMasterUpsertField, string | null>;
  errors: ExecutiveMappedRowError[];
}

/**
 * Map one Base DS data row onto executive_master fields.
 * - Reads the CALCULATED value only (caller is responsible for sourcing rows
 *   from a data_only / calculated read — never the raw formula text).
 * - Any Excel error code found in a mapped cell is blanked to NULL and
 *   recorded in `errors` (row/column/errorType) — never stored, never thrown.
 * - `priority` is passed through `normalizeExecutivePriority` by the caller
 *   (kept out of this pure mapping function to avoid a circular import here;
 *   see `executive-master-reconcile-postgres.ts`).
 */
export function mapExecutiveBaseDsRow(
  headerIndex: ExecutiveBaseDsHeaderIndex,
  row: unknown[]
): ExecutiveMappedRow | null {
  const jrRaw =
    headerIndex.jobRequisitionId >= 0
      ? row[headerIndex.jobRequisitionId]
      : null;
  const jobRequisitionId = normalizeExecutiveCellText(jrRaw);
  if (!jobRequisitionId) return null;

  const errors: ExecutiveMappedRowError[] = [];
  const values = {} as Record<ExecutiveMasterUpsertField, string | null>;

  const readCell = (columnLabel: string, idx: number | undefined): string | null => {
    if (idx == null || idx < 0) return null;
    const raw = row[idx];
    const errorType = classifyExecutiveExcelError(raw);
    if (errorType) {
      errors.push({ column: columnLabel, errorType });
      return null;
    }
    return normalizeExecutiveCellText(raw);
  };

  values.market_map = readCell(
    headerIndex.marketMap.source === "new"
      ? "Final Market Map (New)"
      : "Final Market Map",
    headerIndex.marketMap.index
  );

  for (const [field, header] of Object.entries(
    EXECUTIVE_BASE_DS_HEADER_ALIASES
  ) as Array<
    [Exclude<ExecutiveMasterUpsertField, "market_map">, string]
  >) {
    values[field] = readCell(header, headerIndex.fields[field]);
  }

  return { jobRequisitionId, values, errors };
}
