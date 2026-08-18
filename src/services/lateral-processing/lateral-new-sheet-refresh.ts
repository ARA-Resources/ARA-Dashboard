/**
 * New Sheet refresh helpers.
 *
 * Refresh runs ONLY after prior Lateral gates succeed.
 * - Keep Row 1 / headers / order
 * - Delete data rows below Row 1 only
 * - Insert via validated header-name mapping
 * - Column A Date = current processing date as DD-MM-YYYY
 */
import {
  EXPECTED_NEW_SHEET_HEADERS,
  headersMatchIgnoringCase,
} from "@/services/lateral-processing/lateral-new-sheet-structure";
import type { ColumnMapping } from "@/services/lateral-processing/data-reader";

/** Current processing date for New Sheet Column A — never Gmail/Excel/source dates. */
export function formatProcessingDateDDMMYYYY(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
}

export function isProcessingDateDDMMYYYY(value: string): boolean {
  return /^\d{2}-\d{2}-\d{4}$/.test((value || "").trim());
}

export interface NewSheetRefreshValidationInput {
  expectedHeaders: readonly string[];
  actualHeaders: string[];
  sourceRowCount: number;
  insertedRowCount: number;
  dataRows: string[][];
  processingDate: string;
  mappings: ColumnMapping[];
  /** Original ATCI DS rows aligned to mapping.sourceColIndex */
  sourceDataRows: string[][];
}

export interface NewSheetRefreshValidationResult {
  ok: boolean;
  reasons: string[];
  checks: {
    row1Unchanged: boolean;
    headerOrderUnchanged: boolean;
    rowCountMatch: boolean;
    datePopulated: boolean;
    jobRequisitionIdPopulated: boolean;
    noUnexpectedColumns: boolean;
    noShiftedColumns: boolean;
  };
}

/**
 * Post-write validation for New Sheet refresh.
 * On failure the caller must rollback — do not continue.
 */
export function validateNewSheetRefresh(
  input: NewSheetRefreshValidationInput
): NewSheetRefreshValidationResult {
  const expected = [...input.expectedHeaders];
  const actual = input.actualHeaders.map((h) => (h ?? "").trim());
  const reasons: string[] = [];

  const row1Unchanged =
    actual.length === expected.length &&
    actual.every((h, i) => headersMatchIgnoringCase(h, expected[i] ?? ""));
  if (!row1Unchanged) {
    reasons.push(
      `Row 1 / header order changed. Expected: ${expected.join(" | ")}. Actual: ${actual.join(" | ") || "(empty)"}`
    );
  }

  const headerOrderUnchanged = row1Unchanged;
  const noUnexpectedColumns =
    actual.length === expected.length &&
    !actual.some((h, i) => expected[i] === undefined && h.trim() !== "");
  if (actual.length > expected.length) {
    reasons.push(
      `Unexpected columns added beyond New Sheet structure (expected ${expected.length}, got ${actual.length}).`
    );
  }

  const rowCountMatch = input.insertedRowCount === input.sourceRowCount;
  if (!rowCountMatch) {
    reasons.push(
      `Source row count (${input.sourceRowCount}) ≠ inserted row count (${input.insertedRowCount}).`
    );
  }

  const dateColOk =
    input.dataRows.length === 0 ||
    input.dataRows.every(
      (row) =>
        (row[0] ?? "").trim() === input.processingDate &&
        isProcessingDateDDMMYYYY(row[0] ?? "")
    );
  if (!dateColOk) {
    reasons.push(
      `Date column (A) must be processing date ${input.processingDate} (DD-MM-YYYY) for every inserted row.`
    );
  }

  const jobIdIndex = expected.findIndex((h) => h === "Job Requisition ID");
  const jobRequisitionIdPopulated =
    jobIdIndex < 0 ||
    input.dataRows.length === 0 ||
    input.dataRows.every((row) => (row[jobIdIndex] ?? "").trim() !== "");
  if (!jobRequisitionIdPopulated) {
    reasons.push("Job Requisition ID is empty on one or more inserted rows.");
  }

  // No data shifted into the wrong column: mapped cells must equal source values.
  let noShiftedColumns = true;
  if (
    input.dataRows.length === input.sourceDataRows.length &&
    input.dataRows.length > 0
  ) {
    for (let r = 0; r < input.dataRows.length; r += 1) {
      for (const mapping of input.mappings) {
        if (mapping.generated || mapping.sourceColIndex < 0) continue;
        const expectedVal = (
          input.sourceDataRows[r][mapping.sourceColIndex] ?? ""
        ).trim();
        const actualVal = (
          input.dataRows[r][mapping.destinationColIndex] ?? ""
        ).trim();
        if (expectedVal !== actualVal) {
          noShiftedColumns = false;
          reasons.push(
            `Column shift detected at data row ${r + 1}, "${mapping.destinationHeader}": expected "${expectedVal}", got "${actualVal}".`
          );
          break;
        }
      }
      if (!noShiftedColumns) break;
    }
  }

  const ok =
    row1Unchanged &&
    headerOrderUnchanged &&
    rowCountMatch &&
    dateColOk &&
    jobRequisitionIdPopulated &&
    noUnexpectedColumns &&
    actual.length <= expected.length &&
    noShiftedColumns;

  return {
    ok,
    reasons,
    checks: {
      row1Unchanged,
      headerOrderUnchanged,
      rowCountMatch,
      datePopulated: dateColOk,
      jobRequisitionIdPopulated,
      noUnexpectedColumns: noUnexpectedColumns && actual.length <= expected.length,
      noShiftedColumns,
    },
  };
}

export const NEW_SHEET_REFRESH_HEADERS = EXPECTED_NEW_SHEET_HEADERS;
