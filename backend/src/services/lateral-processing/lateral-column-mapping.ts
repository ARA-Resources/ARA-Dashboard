/**
 * Stage 30A: ATCI DS → New Sheet column mapping (header-name based).
 * Matches Next src/services/lateral-processing/lateral-column-mapping.ts.
 */
import type { ColumnMapping } from "../../types/lateral-processing-preview.js";
import { EXPECTED_NEW_SHEET_HEADERS } from "./lateral-new-sheet-structure.js";

export const GENERATED_NEW_SHEET_DATE_HEADER = "Date";

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
  "Primary Location/Office Locate": [
    "Primary Location/Office Locate",
    "Primary Location/Office locate",
    "Primary Location",
  ],
  "Market Map": ["Market Map"],
  POC: ["POC"],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findSourceHeaderIndex(
  candidates: readonly string[],
  sourceHeaders: string[]
): number | undefined {
  for (const candidate of candidates) {
    const exact = sourceHeaders.findIndex((h) => h === candidate);
    if (exact >= 0) return exact;
  }
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const hit = sourceHeaders.findIndex((h) => h.trim().toLowerCase() === lower);
    if (hit >= 0) return hit;
  }
  for (const candidate of candidates) {
    const candNorm = normalizeHeader(candidate);
    if (!candNorm) continue;
    const hit = sourceHeaders.findIndex((h) => normalizeHeader(h) === candNorm);
    if (hit >= 0) return hit;
  }
  return undefined;
}

export function formatColumnMappingFailureMessage(failure: {
  missingHeaders: string[];
  sourceHeadersFound: string[];
  destinationHeadersExpected: readonly string[];
}): string {
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

export function mapAtciDsToNewSheet(
  sourceHeaders: string[],
  destinationHeaders: readonly string[] = EXPECTED_NEW_SHEET_HEADERS
):
  | {
      ok: true;
      mappings: ColumnMapping[];
    }
  | {
      ok: false;
      missingHeaders: string[];
      sourceHeadersFound: string[];
      destinationHeadersExpected: readonly string[];
      message: string;
    } {
  const sourceHeadersFound = sourceHeaders.map((h) => (h ?? "").trim());
  const destinationHeadersExpected = [...destinationHeaders];

  const mappings: ColumnMapping[] = [];
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
      mappings.push({
        destinationHeader: trimmed,
        sourceHeader: "(system date)",
        sourceColIndex: -1,
        destinationColIndex: destIdx,
        generated: true,
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
  });

  if (missingHeaders.length > 0) {
    const failure = {
      ok: false as const,
      missingHeaders,
      sourceHeadersFound,
      destinationHeadersExpected,
      message: "",
    };
    failure.message = formatColumnMappingFailureMessage(failure);
    return failure;
  }

  return { ok: true, mappings };
}

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
