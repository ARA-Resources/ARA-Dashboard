/**
 * Confirmed Base DS → New Sheet column mapping (Phase 4B).
 * Mapping is by header name only — never by column position.
 */

export const EXECUTIVE_BASE_DS_SHEET_NAME = "Base DS" as const;
export const EXECUTIVE_NEW_SHEET_NAME = "New Sheet" as const;

/** Confirmed destination Google Spreadsheet (override with env if needed). */
export const EXECUTIVE_NEW_SHEET_SPREADSHEET_ID_DEFAULT =
  "1PQ3ZZDAjOPO40zqOVxK_eDUeRyctnj0R";

/** Confirmed Gmail attachment prefix (date portion varies). */
export const EXECUTIVE_DS_ATTACHMENT_PREFIX = "ATCI Exec DS_";

export const EXECUTIVE_BASE_DS_REQUIRED_HEADERS = [
  "Final Market Map",
  "Job Requisition ID",
  "Primary skills",
  "Job Management Level",
  "Skill Categorization",
  "Primary Location",
  "Mandatory skill",
  "Location Flex",
  "Job Description",
  "Priority",
] as const;

export const EXECUTIVE_NEW_SHEET_REQUIRED_HEADERS = [
  "Market",
  "Job requisition ID",
  "Primary Skill",
  "Level",
  "Skill category",
  "Primary Location",
  "Must Have skills",
  "Location Flex",
  "Job Description",
  "Priority",
] as const;

/**
 * Confirmed source → destination header mapping.
 * Keys = Base DS headers; values = New Sheet headers.
 */
export const EXECUTIVE_BASE_DS_TO_NEW_SHEET_MAP = {
  "Final Market Map": "Market",
  "Job Requisition ID": "Job requisition ID",
  "Primary skills": "Primary Skill",
  "Job Management Level": "Level",
  "Skill Categorization": "Skill category",
  "Primary Location": "Primary Location",
  "Mandatory skill": "Must Have skills",
  "Location Flex": "Location Flex",
  "Job Description": "Job Description",
  Priority: "Priority",
} as const;

export type ExecutiveBaseDsHeader =
  (typeof EXECUTIVE_BASE_DS_REQUIRED_HEADERS)[number];
export type ExecutiveNewSheetHeader =
  (typeof EXECUTIVE_NEW_SHEET_REQUIRED_HEADERS)[number];

export type ExecutiveCellValue = string | number | boolean | null;

export interface ExecutiveMappedImportPlan {
  /** Destination headers in exact New Sheet order (full header row). */
  destinationHeaders: string[];
  /** Index of each required destination header in destinationHeaders. */
  destinationIndexByHeader: Record<string, number>;
  /** Source header → destination header. */
  mapping: Record<string, string>;
  /** Destination headers that have no Base DS mapping (left blank). */
  unmappedDestinationHeaders: string[];
}

function asHeader(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findHeaderIndex(headers: string[], required: string): number {
  const target = required.toLowerCase();
  return headers.findIndex((header) => header.toLowerCase() === target);
}

export function validateExecutiveBaseDsHeaders(headers: string[]): {
  ok: boolean;
  missing: string[];
  present: string[];
} {
  const missing: string[] = [];
  const present: string[] = [];
  for (const required of EXECUTIVE_BASE_DS_REQUIRED_HEADERS) {
    if (findHeaderIndex(headers, required) >= 0) present.push(required);
    else missing.push(required);
  }
  return { ok: missing.length === 0, missing, present };
}

export function validateExecutiveNewSheetHeaders(headers: string[]): {
  ok: boolean;
  missing: string[];
  present: string[];
} {
  const missing: string[] = [];
  const present: string[] = [];
  for (const required of EXECUTIVE_NEW_SHEET_REQUIRED_HEADERS) {
    if (findHeaderIndex(headers, required) >= 0) present.push(required);
    else missing.push(required);
  }
  return { ok: missing.length === 0, missing, present };
}

/**
 * Build import plan from actual destination header order.
 * Unmapped destination columns are preserved and left blank.
 */
export function buildExecutiveImportPlan(
  destinationHeadersRaw: unknown[]
): ExecutiveMappedImportPlan {
  const destinationHeaders = destinationHeadersRaw.map(asHeader);
  const destCheck = validateExecutiveNewSheetHeaders(destinationHeaders);
  if (!destCheck.ok) {
    throw new Error(
      `New Sheet is missing required headers: ${destCheck.missing.join(", ")}`
    );
  }

  const destinationIndexByHeader: Record<string, number> = {};
  for (const required of EXECUTIVE_NEW_SHEET_REQUIRED_HEADERS) {
    destinationIndexByHeader[required] = findHeaderIndex(
      destinationHeaders,
      required
    );
  }

  const mappedDest = new Set(
    Object.values(EXECUTIVE_BASE_DS_TO_NEW_SHEET_MAP).map((h) => h.toLowerCase())
  );
  const unmappedDestinationHeaders = destinationHeaders.filter(
    (header) => header && !mappedDest.has(header.toLowerCase())
  );

  return {
    destinationHeaders,
    destinationIndexByHeader,
    mapping: { ...EXECUTIVE_BASE_DS_TO_NEW_SHEET_MAP },
    unmappedDestinationHeaders,
  };
}

/**
 * Map Base DS data rows onto New Sheet column order.
 * Never uses source column positions — only header names.
 */
export function mapBaseDsRowsToNewSheet(
  sourceHeadersRaw: unknown[],
  sourceRows: unknown[][],
  plan: ExecutiveMappedImportPlan
): {
  outputRows: ExecutiveCellValue[][];
  sourceHeaderIndexByName: Record<string, number>;
} {
  const sourceHeaders = sourceHeadersRaw.map(asHeader);
  const sourceCheck = validateExecutiveBaseDsHeaders(sourceHeaders);
  if (!sourceCheck.ok) {
    throw new Error(
      `Base DS is missing required headers: ${sourceCheck.missing.join(", ")}`
    );
  }

  const sourceHeaderIndexByName: Record<string, number> = {};
  for (const required of EXECUTIVE_BASE_DS_REQUIRED_HEADERS) {
    sourceHeaderIndexByName[required] = findHeaderIndex(
      sourceHeaders,
      required
    );
  }

  const colCount = plan.destinationHeaders.length;
  const outputRows: ExecutiveCellValue[][] = sourceRows.map((row) => {
    const out: ExecutiveCellValue[] = Array.from(
      { length: colCount },
      () => null
    );

    for (const [sourceHeader, destHeader] of Object.entries(
      EXECUTIVE_BASE_DS_TO_NEW_SHEET_MAP
    )) {
      const srcIdx = sourceHeaderIndexByName[sourceHeader];
      const destIdx = plan.destinationIndexByHeader[destHeader];
      if (srcIdx < 0 || destIdx < 0) continue;
      const raw = row[srcIdx];
      out[destIdx] = normalizeCellForSheets(raw, sourceHeader);
    }

    return out;
  });

  return { outputRows, sourceHeaderIndexByName };
}

/**
 * Preserve JR IDs as text when numeric coercion would alter them.
 * Leave other primitives as-is; blanks → null.
 */
export function normalizeCellForSheets(
  value: unknown,
  sourceHeader: string
): ExecutiveCellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.replace(/\u00a0/g, " ");
    if (!trimmed.trim()) return null;
    if (/^job\s*requisition\s*id$/i.test(sourceHeader)) {
      // Keep as string to avoid scientific notation / leading-zero loss.
      return trimmed;
    }
    return trimmed;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (/^job\s*requisition\s*id$/i.test(sourceHeader)) {
      return String(value);
    }
    return value;
  }
  if (typeof value === "boolean") return value;
  if (value instanceof Date) {
    return value.toISOString();
  }
  const text = String(value);
  return text.trim() ? text : null;
}

export function isExecutiveDsAttachmentName(filename: string): boolean {
  const base = filename.split(/[/\\]/).pop()?.trim() ?? "";
  return /^ATCI Exec DS_.+\.xlsx$/i.test(base);
}
