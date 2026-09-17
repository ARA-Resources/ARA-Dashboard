/**
 * Executive Posted Sheet raw-text cleaner.
 *
 * Mirrors the confirmed logic of the real workbook's own VBA macro,
 * `PostedJobsWorkDay` (Module21, decompiled 2026-09-17), which this pipeline
 * supersedes rather than imitates in direction: the macro reads Master
 * Sheet's Posted column as truth and writes Yes/No onto Posted Sheet; this
 * pipeline does the opposite — Posted Sheet is the source of truth, cleaned
 * here and fed into `executive-posted-demand-rule.ts` to decide
 * `executive_master.posted`.
 *
 * Two rules, matching the macro exactly:
 * 1. Keep only rows whose raw column-A text starts with "ATCI" (macro:
 *    `Cells(i, 1).Value Like "ATCI*"` — no trimming before this check, so a
 *    row with leading whitespace is correctly rejected here too).
 * 2. For kept rows, the Job Requisition ID is the column-A text, TRIMMED,
 *    then truncated at the first space (macro: `Trim(...)`, then
 *    `Left(jobID, InStr(jobID, " ") - 1)` when a space exists).
 *
 * Column B's pre-existing value (if any) is never trusted — the ID is always
 * recomputed here from column A, since column B only reflects whichever
 * cleanup a human last ran by hand.
 */

export function shouldKeepExecutivePostedRow(rawColumnAValue: unknown): boolean {
  const raw = typeof rawColumnAValue === "string" ? rawColumnAValue : String(rawColumnAValue ?? "");
  return raw.startsWith("ATCI");
}

export function extractExecutivePostedJobRequisitionId(
  rawColumnAValue: unknown
): string {
  const trimmed = String(rawColumnAValue ?? "").trim();
  const spaceIdx = trimmed.indexOf(" ");
  return spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed;
}

export interface ExecutivePostedRawRow {
  /** 1-based sheet row number, kept only for traceability/logging. */
  rowNumber: number;
  columnA: unknown;
  /** Passed through unchanged; interpreted by `executive-posted-demand-rule.ts`. */
  columnC: unknown;
}

export interface ExecutivePostedCleanedRow {
  rowNumber: number;
  rawText: string;
  jobRequisitionId: string;
  demand: unknown;
}

export interface ExecutivePostedRemovedRow {
  rowNumber: number;
  rawText: string;
}

export interface ExecutivePostedCleanResult {
  kept: ExecutivePostedCleanedRow[];
  removed: ExecutivePostedRemovedRow[];
}

/**
 * Apply both rules to a full set of raw Posted Sheet data rows (header row
 * excluded by the caller). Order of `kept`/`removed` matches input order.
 */
export function cleanExecutivePostedRows(
  rows: ExecutivePostedRawRow[]
): ExecutivePostedCleanResult {
  const kept: ExecutivePostedCleanedRow[] = [];
  const removed: ExecutivePostedRemovedRow[] = [];

  for (const row of rows) {
    const rawText = typeof row.columnA === "string" ? row.columnA : String(row.columnA ?? "");
    if (!shouldKeepExecutivePostedRow(row.columnA)) {
      removed.push({ rowNumber: row.rowNumber, rawText });
      continue;
    }
    kept.push({
      rowNumber: row.rowNumber,
      rawText,
      jobRequisitionId: extractExecutivePostedJobRequisitionId(row.columnA),
      demand: row.columnC,
    });
  }

  return { kept, removed };
}
