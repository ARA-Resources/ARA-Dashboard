/**
 * One-time Lateral Master Sheet → PostgreSQL `lateral_master` backfill.
 *
 * Pure validation / mapping helpers (no pipeline, Gmail, Dashboard, or UPSERT).
 * Live Job Status / Posted / field UPSERT belong in later phases.
 */

export const LATERAL_MASTER_SHEET_NAME = "Master Sheet";

export const ALLOWED_JOB_STATUSES = [
  "New",
  "Reopen",
  "Active",
  "Closed",
] as const;

export type AllowedJobStatus = (typeof ALLOWED_JOB_STATUSES)[number];

export const ALLOWED_POSTED_VALUES = ["Yes", "-"] as const;
export type AllowedPosted = (typeof ALLOWED_POSTED_VALUES)[number];

/** Canonical PG Master business fields (excluding timestamps). */
export type LateralMasterBackfillField =
  | "job_requisition_id"
  | "date"
  | "priority"
  | "job_description"
  | "skill_categorization"
  | "primary_skills"
  | "job_management_level"
  | "primary_location"
  | "market_map"
  | "poc"
  | "job_status"
  | "posted";

/**
 * Header candidates for Master Sheet → PG mapping.
 * Match by name (exact → case-insensitive → normalized), never by position alone.
 */
export const MASTER_BACKFILL_HEADER_CANDIDATES: Record<
  LateralMasterBackfillField,
  readonly string[]
> = {
  job_requisition_id: ["Job Requisition ID"],
  date: ["Date"],
  priority: ["Priority"],
  job_description: ["Job Description"],
  skill_categorization: ["Skill Categorization"],
  primary_skills: ["Primary Skills"],
  job_management_level: ["Job Management Level"],
  primary_location: [
    "Primary Location/Office Locate",
    "Primary Location/Office locate",
    "Primary Location/Office lOcate",
    "Primary Location",
  ],
  market_map: ["Market Map"],
  poc: ["POC"],
  job_status: ["Job Status"],
  posted: ["Posted"],
};

export const REQUIRED_BACKFILL_FIELDS: readonly LateralMasterBackfillField[] = [
  "job_requisition_id",
  "date",
  "priority",
  "job_description",
  "skill_categorization",
  "primary_skills",
  "job_management_level",
  "primary_location",
  "market_map",
  "poc",
  "job_status",
  "posted",
];

export interface HeaderMappingSuccess {
  ok: true;
  /** field → 0-based source column index */
  fieldToIndex: Record<LateralMasterBackfillField, number>;
  /** field → matched source header text */
  fieldToHeader: Record<LateralMasterBackfillField, string>;
  sourceHeaders: string[];
  ignoredHeaders: string[];
}

export interface HeaderMappingFailure {
  ok: false;
  reason: "missing" | "ambiguous";
  message: string;
  missingFields: LateralMasterBackfillField[];
  ambiguousFields: Array<{
    field: LateralMasterBackfillField;
    matches: string[];
  }>;
  sourceHeaders: string[];
}

export type HeaderMappingResult = HeaderMappingSuccess | HeaderMappingFailure;

export interface LateralMasterBackfillRow {
  excelRowNumber: number;
  job_requisition_id: string;
  date: string | null; // YYYY-MM-DD
  priority: string | null;
  job_description: string | null;
  skill_categorization: string | null;
  primary_skills: string | null;
  job_management_level: string | null;
  primary_location: string | null;
  market_map: string | null;
  poc: string | null;
  job_status: AllowedJobStatus | null;
  posted: AllowedPosted | null;
}

export interface DuplicateJrReport {
  jobRequisitionId: string;
  excelRowNumbers: number[];
}

export interface InvalidValueReport {
  excelRowNumber: number;
  jobRequisitionId?: string;
  field: string;
  value: string;
}

export interface RowValidationSuccess {
  ok: true;
  rows: LateralMasterBackfillRow[];
  totalExcelDataRows: number;
  skippedEmptyRows: number;
  ignoredExtraColumns: string[];
}

export interface RowValidationFailure {
  ok: false;
  message: string;
  totalExcelDataRows: number;
  skippedEmptyRows: number;
  missingJrRows: number[];
  duplicateJrs: DuplicateJrReport[];
  invalidJobStatuses: InvalidValueReport[];
  invalidPosted: InvalidValueReport[];
  invalidDates: InvalidValueReport[];
}

export type RowValidationResult = RowValidationSuccess | RowValidationFailure;

export interface ExistingMasterProtection {
  existingCount: number;
  overlappingIds: string[];
  newIds: string[];
  sourceIds: number;
}

export interface LateralMasterBackfillReport {
  source: {
    workbookPath: string;
    workbookFilename: string;
    sheetName: string;
    detectedHeaders: string[];
    ignoredHeaders: string[];
  };
  rows: {
    totalExcelDataRows: number;
    skippedEmptyRows: number;
    validRows: number;
    invalidRows: number;
    duplicateJrCount: number;
    missingJrCount: number;
    invalidJobStatusCount: number;
    invalidPostedCount: number;
    invalidDateCount: number;
  };
  distributions?: {
    jobStatus: Record<string, number>;
    posted: Record<string, number>;
  };
  database: {
    existingCountBefore: number;
    overlappingIds: number;
    newIds: number;
    rowsInserted: number;
    rowsSkipped: number;
    rowsFailed: number;
    finalCount: number | null;
  };
  importTimestamp: string;
  status: "success" | "aborted" | "failed";
  message: string;
}

/** Normalize header: trim, lower, strip non-alphanumeric (spaces/punct/underscores). */
export function normalizeHeader(h: string): string {
  return String(h ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function isAllowedJobStatus(value: string): value is AllowedJobStatus {
  return (ALLOWED_JOB_STATUSES as readonly string[]).includes(value);
}

export function isAllowedPosted(value: string): value is AllowedPosted {
  return (ALLOWED_POSTED_VALUES as readonly string[]).includes(value);
}

/**
 * Resolve Master Sheet headers → PG fields by name.
 * Stops on missing required fields or ambiguous matches.
 */
export function mapMasterSheetHeaders(
  sourceHeaders: string[]
): HeaderMappingResult {
  const headers = sourceHeaders.map((h) => String(h ?? "").trim());
  const fieldToIndex = {} as Record<LateralMasterBackfillField, number>;
  const fieldToHeader = {} as Record<LateralMasterBackfillField, string>;
  const missingFields: LateralMasterBackfillField[] = [];
  const ambiguousFields: HeaderMappingFailure["ambiguousFields"] = [];
  const claimed = new Set<number>();

  for (const field of REQUIRED_BACKFILL_FIELDS) {
    const candidates = MASTER_BACKFILL_HEADER_CANDIDATES[field];
    const matches: Array<{ index: number; header: string }> = [];

    // Exact
    for (const candidate of candidates) {
      headers.forEach((header, index) => {
        if (header === candidate) matches.push({ index, header });
      });
    }
    // Case-insensitive
    if (matches.length === 0) {
      for (const candidate of candidates) {
        const lower = candidate.toLowerCase();
        headers.forEach((header, index) => {
          if (header.toLowerCase() === lower) matches.push({ index, header });
        });
      }
    }
    // Normalized
    if (matches.length === 0) {
      for (const candidate of candidates) {
        const candNorm = normalizeHeader(candidate);
        if (!candNorm) continue;
        headers.forEach((header, index) => {
          if (normalizeHeader(header) === candNorm) {
            matches.push({ index, header });
          }
        });
      }
    }

    // Deduplicate by index
    const unique = new Map<number, string>();
    for (const m of matches) unique.set(m.index, m.header);

    if (unique.size === 0) {
      missingFields.push(field);
      continue;
    }
    if (unique.size > 1) {
      ambiguousFields.push({
        field,
        matches: [...unique.values()],
      });
      continue;
    }

    const [[index, header]] = unique.entries();
    if (claimed.has(index)) {
      ambiguousFields.push({
        field,
        matches: [header, `(already claimed by another field at column ${index + 1})`],
      });
      continue;
    }
    claimed.add(index);
    fieldToIndex[field] = index;
    fieldToHeader[field] = header;
  }

  if (missingFields.length > 0 || ambiguousFields.length > 0) {
    const parts: string[] = [];
    if (missingFields.length > 0) {
      parts.push(`Missing required header(s): ${missingFields.join(", ")}`);
    }
    if (ambiguousFields.length > 0) {
      parts.push(
        `Ambiguous header(s): ${ambiguousFields
          .map((a) => `${a.field} → [${a.matches.join(" | ")}]`)
          .join("; ")}`
      );
    }
    return {
      ok: false,
      reason: missingFields.length > 0 ? "missing" : "ambiguous",
      message: [
        "Master Sheet header mapping failed. Import stopped.",
        ...parts,
        `Source headers found: ${headers.filter(Boolean).join(" | ") || "(none)"}`,
      ].join("\n"),
      missingFields,
      ambiguousFields,
      sourceHeaders: headers,
    };
  }

  const ignoredHeaders = headers.filter(
    (header, index) => header && !claimed.has(index)
  );

  return {
    ok: true,
    fieldToIndex,
    fieldToHeader,
    sourceHeaders: headers,
    ignoredHeaders,
  };
}

function cellIsEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  return false;
}

/** Empty → null; otherwise trimmed string. Never invents N/A/null/None. */
export function normalizeOptionalText(value: unknown): string | null {
  if (cellIsEmpty(value)) return null;
  if (value instanceof Date) {
    // Should not happen for text fields; stringify date only if mis-typed
    return value.toISOString().slice(0, 10);
  }
  const text = String(value)
    .replace(/\u00a0/g, " ")
    .trim();
  return text.length === 0 ? null : text;
}

/**
 * Convert Excel/JSON cell to YYYY-MM-DD for PostgreSQL DATE, or null.
 * Accepts Date, ISO strings, DD/MM/YYYY, DD-MM-YYYY, Excel serial numbers.
 */
export function parseExcelDateToIso(
  value: unknown
): { ok: true; iso: string | null } | { ok: false; raw: string } {
  if (cellIsEmpty(value)) return { ok: true, iso: null };

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    // Prefer local calendar components when time is midnight local (Excel dates)
    const ly = value.getFullYear();
    const lm = String(value.getMonth() + 1).padStart(2, "0");
    const ld = String(value.getDate()).padStart(2, "0");
    // Excel dates from openpyxl are usually naive local midnights
    if (
      value.getHours() === 0 &&
      value.getMinutes() === 0 &&
      value.getSeconds() === 0
    ) {
      return { ok: true, iso: `${ly}-${lm}-${ld}` };
    }
    return { ok: true, iso: `${y}-${m}-${d}` };
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel serial date (days since 1899-12-30)
    const excelEpoch = Date.UTC(1899, 11, 30);
    const ms = excelEpoch + Math.round(value) * 86400000;
    const dt = new Date(ms);
    if (Number.isNaN(dt.getTime())) return { ok: false, raw: String(value) };
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dt.getUTCDate()).padStart(2, "0");
    return { ok: true, iso: `${y}-${m}-${d}` };
  }

  const raw = String(value).trim();
  if (!raw) return { ok: true, iso: null };

  // ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const iso = raw.slice(0, 10);
    const dt = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(dt.getTime())) return { ok: false, raw };
    return { ok: true, iso };
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return { ok: false, raw };
    }
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dt = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(dt.getTime())) return { ok: false, raw };
    return { ok: true, iso };
  }

  // Last resort: Date.parse
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const mo = String(parsed.getMonth() + 1).padStart(2, "0");
    const d = String(parsed.getDate()).padStart(2, "0");
    return { ok: true, iso: `${y}-${mo}-${d}` };
  }

  return { ok: false, raw };
}

/**
 * Validate and map raw sheet rows (array of cell values aligned to headers).
 * `rawRows` excludes the header row; `excelRowNumber` starts at 2.
 */
export function validateAndBuildBackfillRows(options: {
  headers: string[];
  rawRows: unknown[][];
  mapping: HeaderMappingSuccess;
}): RowValidationResult {
  const { rawRows, mapping } = options;
  const missingJrRows: number[] = [];
  const duplicateJrs: DuplicateJrReport[] = [];
  const invalidJobStatuses: InvalidValueReport[] = [];
  const invalidPosted: InvalidValueReport[] = [];
  const invalidDates: InvalidValueReport[] = [];
  const seen = new Map<string, number[]>();
  const rows: LateralMasterBackfillRow[] = [];
  let skippedEmptyRows = 0;

  const idx = mapping.fieldToIndex;

  for (let i = 0; i < rawRows.length; i += 1) {
    const excelRowNumber = i + 2;
    const cells = rawRows[i] ?? [];

    const allEmpty = cells.every((c) => cellIsEmpty(c));
    if (allEmpty) {
      skippedEmptyRows += 1;
      continue;
    }

    const jrRaw = cells[idx.job_requisition_id];
    const jr =
      jrRaw === null || jrRaw === undefined
        ? ""
        : String(jrRaw).replace(/\u00a0/g, " ").trim();

    if (!jr) {
      missingJrRows.push(excelRowNumber);
      continue;
    }

    const dateResult = parseExcelDateToIso(cells[idx.date]);
    if (!dateResult.ok) {
      invalidDates.push({
        excelRowNumber,
        jobRequisitionId: jr,
        field: "date",
        value: dateResult.raw,
      });
    }

    const statusText = normalizeOptionalText(cells[idx.job_status]);
    let job_status: AllowedJobStatus | null = null;
    if (statusText !== null) {
      if (!isAllowedJobStatus(statusText)) {
        invalidJobStatuses.push({
          excelRowNumber,
          jobRequisitionId: jr,
          field: "job_status",
          value: statusText,
        });
      } else {
        job_status = statusText;
      }
    }

    const postedText = normalizeOptionalText(cells[idx.posted]);
    let posted: AllowedPosted | null = null;
    if (postedText !== null) {
      if (!isAllowedPosted(postedText)) {
        invalidPosted.push({
          excelRowNumber,
          jobRequisitionId: jr,
          field: "posted",
          value: postedText,
        });
      } else {
        posted = postedText;
      }
    }

    const list = seen.get(jr) ?? [];
    list.push(excelRowNumber);
    seen.set(jr, list);

    if (
      dateResult.ok &&
      (statusText === null || job_status !== null) &&
      (postedText === null || posted !== null)
    ) {
      // Only push provisional row; duplicates / other errors invalidate later
      rows.push({
        excelRowNumber,
        job_requisition_id: jr,
        date: dateResult.ok ? dateResult.iso : null,
        priority: normalizeOptionalText(cells[idx.priority]),
        job_description: normalizeOptionalText(cells[idx.job_description]),
        skill_categorization: normalizeOptionalText(
          cells[idx.skill_categorization]
        ),
        primary_skills: normalizeOptionalText(cells[idx.primary_skills]),
        job_management_level: normalizeOptionalText(
          cells[idx.job_management_level]
        ),
        primary_location: normalizeOptionalText(cells[idx.primary_location]),
        market_map: normalizeOptionalText(cells[idx.market_map]),
        poc: normalizeOptionalText(cells[idx.poc]),
        job_status,
        posted,
      });
    }
  }

  for (const [jobRequisitionId, excelRowNumbers] of seen) {
    if (excelRowNumbers.length > 1) {
      duplicateJrs.push({ jobRequisitionId, excelRowNumbers });
    }
  }

  const totalExcelDataRows = rawRows.length;
  const hasErrors =
    missingJrRows.length > 0 ||
    duplicateJrs.length > 0 ||
    invalidJobStatuses.length > 0 ||
    invalidPosted.length > 0 ||
    invalidDates.length > 0;

  if (hasErrors) {
    const parts: string[] = ["Master Sheet row validation failed. Import stopped."];
    if (duplicateJrs.length > 0) {
      parts.push(
        `Duplicate Job Requisition ID(s): ${duplicateJrs
          .slice(0, 20)
          .map(
            (d) =>
              `${d.jobRequisitionId} @ rows ${d.excelRowNumbers.join(", ")}`
          )
          .join("; ")}${duplicateJrs.length > 20 ? ` (+${duplicateJrs.length - 20} more)` : ""}`
      );
    }
    if (missingJrRows.length > 0) {
      parts.push(
        `Missing Job Requisition ID on Excel row(s): ${missingJrRows.slice(0, 30).join(", ")}${missingJrRows.length > 30 ? ` (+${missingJrRows.length - 30} more)` : ""}`
      );
    }
    if (invalidJobStatuses.length > 0) {
      parts.push(
        `Invalid Job Status: ${invalidJobStatuses
          .slice(0, 20)
          .map((r) => `row ${r.excelRowNumber} "${r.value}"`)
          .join("; ")}`
      );
    }
    if (invalidPosted.length > 0) {
      parts.push(
        `Invalid Posted: ${invalidPosted
          .slice(0, 20)
          .map((r) => `row ${r.excelRowNumber} "${r.value}"`)
          .join("; ")}`
      );
    }
    if (invalidDates.length > 0) {
      parts.push(
        `Invalid Date: ${invalidDates
          .slice(0, 20)
          .map((r) => `row ${r.excelRowNumber} "${r.value}"`)
          .join("; ")}`
      );
    }
    return {
      ok: false,
      message: parts.join("\n"),
      totalExcelDataRows,
      skippedEmptyRows,
      missingJrRows,
      duplicateJrs,
      invalidJobStatuses,
      invalidPosted,
      invalidDates,
    };
  }

  // Dedupe safety: if no duplicate errors, rows length should equal unique JRs
  return {
    ok: true,
    rows,
    totalExcelDataRows,
    skippedEmptyRows,
    ignoredExtraColumns: mapping.ignoredHeaders,
  };
}

export function analyzeExistingMasterProtection(options: {
  sourceIds: string[];
  existingIds: string[];
}): ExistingMasterProtection {
  const existingSet = new Set(options.existingIds);
  const overlappingIds: string[] = [];
  const newIds: string[] = [];
  for (const id of options.sourceIds) {
    if (existingSet.has(id)) overlappingIds.push(id);
    else newIds.push(id);
  }
  return {
    existingCount: options.existingIds.length,
    overlappingIds,
    newIds,
    sourceIds: options.sourceIds.length,
  };
}

export function countDistribution(
  rows: LateralMasterBackfillRow[],
  field: "job_status" | "posted"
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = row[field] ?? "(null)";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Display timezone for Lateral PostgreSQL timestamps (user-facing only). */
export const LATERAL_PG_DISPLAY_TIMEZONE = "Asia/Kolkata" as const;

/**
 * Format a PostgreSQL DATE (YYYY-MM-DD) for user-facing display.
 * Output: DD/MM/YYYY — no time component.
 * Does not change storage; DATE remains DATE in PostgreSQL.
 */
export function formatLateralPgDateDdMmYyyy(
  iso: string | null | undefined
): string {
  if (!iso) return "";
  const m = String(iso).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** @deprecated Prefer {@link formatLateralPgDateDdMmYyyy} — kept for call-site compatibility. */
export function formatIsoDateDdMmYyyy(iso: string | null): string {
  return formatLateralPgDateDdMmYyyy(iso);
}

/**
 * Format a TIMESTAMPTZ / Date / ISO instant for user-facing display.
 * Converts to Asia/Kolkata first, then formats as:
 *   DD/MM/YYYY, HH:MM:SS IST
 *
 * Does NOT store formatted strings — PostgreSQL keeps TIMESTAMPTZ.
 */
export function formatLateralPgTimestampIst(
  value: Date | string | null | undefined
): string {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LATERAL_PG_DISPLAY_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  const day = get("day");
  const month = get("month");
  const year = get("year");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");

  return `${day}/${month}/${year}, ${hour}:${minute}:${second} IST`;
}
