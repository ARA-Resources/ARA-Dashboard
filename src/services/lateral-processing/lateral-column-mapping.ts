/**
 * ATCI DS → New Sheet column mapping (header-name based).
 *
 * Destination (New Sheet) header order is the source of truth:
 *   Date | Job Requisition ID | Priority | Job Description |
 *   Skill Categorization | Primary Skills | Job Management Level |
 *   Primary Location/Office Locate | Market Map | POC
 *
 * Rules:
 * - NEVER map by column position
 * - Date is destination-generated (ATCI DS has no Date)
 * - Every other New Sheet header must match an ATCI DS header by name
 * - Extra ATCI DS columns are ignored (not added to New Sheet)
 * - Do not change New Sheet column order
 * - On missing required match: STOP — no partial import, no New Sheet clear
 */
import type { ColumnMapping } from "@/services/lateral-processing/data-reader";
import { EXPECTED_NEW_SHEET_HEADERS } from "@/services/lateral-processing/lateral-new-sheet-structure";

/** Destination-generated field — not present on ATCI DS. */
export const GENERATED_NEW_SHEET_DATE_HEADER = "Date";

/**
 * Explicit New Sheet ← ATCI DS header candidates (name match, not position).
 * First candidate that exists in ATCI DS wins.
 */
export const NEW_SHEET_TO_ATCI_DS_CANDIDATES: Record<
  string,
  "generated" | readonly string[]
> = {
  Date: "generated",
  "Job Requisition ID": ["Job Requisition ID"],
  Priority: ["Priority"],
  "Job Description": ["Job Description"],
  "Skill Categorization": ["Skill Categorization"],
  "Primary Skills": ["Primary Skills"],
  "Job Management Level": ["Job Management Level"],
  // New Sheet label vs common ATCI DS label
  "Primary Location/Office Locate": [
    "Primary Location/Office Locate",
    "Primary Location/Office locate",
    "Primary Location",
  ],
  "Market Map": ["Market Map"],
  POC: ["POC"],
};

export interface ExplicitHeaderMapping {
  /** ATCI DS header (or "(system date)" when generated) */
  atciDsHeader: string;
  /** New Sheet header */
  newSheetHeader: string;
  generated: boolean;
  sourceColIndex: number;
  destinationColIndex: number;
}

export interface AtciDsToNewSheetMappingSuccess {
  ok: true;
  /** Mappings in New Sheet column order (never rearranged) */
  mappings: ColumnMapping[];
  /** Same mappings with ATCI DS → New Sheet wording */
  explicitMappings: ExplicitHeaderMapping[];
  destinationHeadersExpected: readonly string[];
  sourceHeadersFound: string[];
  /** Extra ATCI DS columns not mapped into New Sheet (ignored on purpose) */
  ignoredSourceHeaders: string[];
}

export interface AtciDsToNewSheetMappingFailure {
  ok: false;
  missingHeaders: string[];
  sourceHeadersFound: string[];
  destinationHeadersExpected: readonly string[];
  /** Human-readable stop message */
  message: string;
}

export type AtciDsToNewSheetMappingResult =
  | AtciDsToNewSheetMappingSuccess
  | AtciDsToNewSheetMappingFailure;

export class LateralColumnMappingError extends Error {
  readonly code = "MAPPING_FAILED" as const;
  readonly failure: AtciDsToNewSheetMappingFailure;

  constructor(failure: AtciDsToNewSheetMappingFailure) {
    super(failure.message);
    this.name = "LateralColumnMappingError";
    this.failure = failure;
  }
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findSourceHeaderIndex(
  candidates: readonly string[],
  sourceHeaders: string[]
): number | undefined {
  // 1) Exact
  for (const candidate of candidates) {
    const exact = sourceHeaders.findIndex((h) => h === candidate);
    if (exact >= 0) return exact;
  }
  // 2) Case-insensitive
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const hit = sourceHeaders.findIndex((h) => h.trim().toLowerCase() === lower);
    if (hit >= 0) return hit;
  }
  // 3) Normalized (punctuation-insensitive), still by header name — not by position
  for (const candidate of candidates) {
    const candNorm = normalizeHeader(candidate);
    if (!candNorm) continue;
    const hit = sourceHeaders.findIndex((h) => normalizeHeader(h) === candNorm);
    if (hit >= 0) return hit;
  }
  return undefined;
}

export function formatColumnMappingFailureMessage(
  failure: Pick<
    AtciDsToNewSheetMappingFailure,
    "missingHeaders" | "sourceHeadersFound" | "destinationHeadersExpected"
  >
): string {
  const missing = failure.missingHeaders.join(", ") || "(none)";
  const source =
    failure.sourceHeadersFound.filter((h) => h.trim()).join(" | ") || "(none)";
  const dest = failure.destinationHeadersExpected.join(" | ");
  return [
    "ATCI DS → New Sheet column mapping failed. Pipeline stopped.",
    "Do NOT partially import. Do NOT clear New Sheet. Columns were not remapped by position.",
    `Missing header: ${missing}`,
    `Source headers found: ${source}`,
    `Destination headers expected: ${dest}`,
  ].join("\n");
}

/**
 * Build explicit ATCI DS → New Sheet mappings by HEADER NAME.
 * Destination order is always {@link EXPECTED_NEW_SHEET_HEADERS} (or provided list).
 */
export function mapAtciDsToNewSheet(
  sourceHeaders: string[],
  destinationHeaders: readonly string[] = EXPECTED_NEW_SHEET_HEADERS
): AtciDsToNewSheetMappingResult {
  const sourceHeadersFound = sourceHeaders.map((h) => (h ?? "").trim());
  const destinationHeadersExpected = [...destinationHeaders];

  const mappings: ColumnMapping[] = [];
  const explicitMappings: ExplicitHeaderMapping[] = [];
  const missingHeaders: string[] = [];
  const usedSourceIndexes = new Set<number>();

  destinationHeadersExpected.forEach((destHeader, destIdx) => {
    const trimmed = destHeader.trim();
    if (!trimmed) return;

    const rule =
      NEW_SHEET_TO_ATCI_DS_CANDIDATES[trimmed] ??
      (trimmed === GENERATED_NEW_SHEET_DATE_HEADER
        ? ("generated" as const)
        : ([trimmed] as const));

    if (rule === "generated") {
      const mapping: ColumnMapping = {
        destinationHeader: trimmed,
        sourceHeader: "(system date)",
        sourceColIndex: -1,
        destinationColIndex: destIdx,
        generated: true,
      };
      mappings.push(mapping);
      explicitMappings.push({
        atciDsHeader: "(system date — not in ATCI DS)",
        newSheetHeader: trimmed,
        generated: true,
        sourceColIndex: -1,
        destinationColIndex: destIdx,
      });
      return;
    }

    const srcIdx = findSourceHeaderIndex(rule, sourceHeadersFound);
    if (srcIdx === undefined) {
      missingHeaders.push(trimmed);
      return;
    }

    usedSourceIndexes.add(srcIdx);
    const sourceHeader = sourceHeadersFound[srcIdx];
    mappings.push({
      destinationHeader: trimmed,
      sourceHeader,
      sourceColIndex: srcIdx,
      destinationColIndex: destIdx,
    });
    explicitMappings.push({
      atciDsHeader: sourceHeader,
      newSheetHeader: trimmed,
      generated: false,
      sourceColIndex: srcIdx,
      destinationColIndex: destIdx,
    });
  });

  if (missingHeaders.length > 0) {
    const failure: AtciDsToNewSheetMappingFailure = {
      ok: false,
      missingHeaders,
      sourceHeadersFound,
      destinationHeadersExpected,
      message: "",
    };
    failure.message = formatColumnMappingFailureMessage(failure);
    return failure;
  }

  const ignoredSourceHeaders = sourceHeadersFound.filter(
    (h, idx) => h.trim() && !usedSourceIndexes.has(idx)
  );

  return {
    ok: true,
    mappings,
    explicitMappings,
    destinationHeadersExpected,
    sourceHeadersFound,
    ignoredSourceHeaders,
  };
}

/**
 * Compatibility wrapper used by data-reader / new-sheet-writer.
 * Maps ATCI DS headers onto destination headers by name (never by position).
 */
export function buildColumnMappingByHeaderName(
  sourceHeaders: string[],
  destinationHeaders: string[]
): ColumnMapping[] | {
  ok: false;
  missingDestinationHeaders: string[];
  availableSourceHeaders: string[];
  message: string;
} {
  const result = mapAtciDsToNewSheet(sourceHeaders, destinationHeaders);
  if (!result.ok) {
    return {
      ok: false,
      missingDestinationHeaders: result.missingHeaders,
      availableSourceHeaders: result.sourceHeadersFound,
      message: result.message,
    };
  }
  return result.mappings;
}
