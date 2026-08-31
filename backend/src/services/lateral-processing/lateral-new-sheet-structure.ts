/**
 * Stage 30A: New Sheet header constants used by preview column mapping.
 * Matches Next lateral-new-sheet-structure.ts (preview subset).
 */

export const EXPECTED_NEW_SHEET_HEADERS = [
  "Date",
  "Job Requisition ID",
  "Priority",
  "Job Description",
  "Skill Categorization",
  "Primary Skills",
  "Job Management Level",
  "Primary Location/Office Locate",
  "Market Map",
  "POC",
] as const;

export function normalizeNewSheetHeaderForCompare(value: string): string {
  return (value ?? "").trim().toLowerCase();
}

export function headersMatchIgnoringCase(
  expected: string,
  actual: string
): boolean {
  return (
    normalizeNewSheetHeaderForCompare(expected) ===
    normalizeNewSheetHeaderForCompare(actual)
  );
}
