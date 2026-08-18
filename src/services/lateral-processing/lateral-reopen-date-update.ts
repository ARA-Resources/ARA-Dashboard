/**
 * Reopen date update — Master Sheet only.
 *
 * When JR is in New Sheet AND Master Sheet AND Column K was Closed:
 *   1. Column K = Reopen
 *   2. Designated Date column for THAT row = today (DD-MM-YYYY)
 *
 * Does NOT update dates for:
 *   - Active rows (even if processed)
 *   - Closed rows that remain absent from New Sheet
 *   - Any unrelated Master rows
 *
 * Does NOT create a duplicate row.
 */
import {
  MASTER_DATE_HEADER,
  MASTER_JOB_STATUS_COLUMN_K,
  MASTER_JOB_STATUS_HEADER,
  resolveLateralJobStatus,
} from "@/services/lateral-processing/lateral-job-status-rules";
import { formatProcessingDateDDMMYYYY } from "@/services/lateral-processing/lateral-new-sheet-refresh";

export const REOPEN_DATE_FORMAT = "DD-MM-YYYY";

/** Processing date string used for Reopen (always DD-MM-YYYY). */
export function formatReopenDateDDMMYYYY(date: Date = new Date()): string {
  return formatProcessingDateDDMMYYYY(date);
}

export function isValidReopenDateFormat(value: string): boolean {
  return /^\d{2}-\d{2}-\d{4}$/.test(value.trim());
}

export interface ReopenDateUpdateDecision {
  /** True when this JR must reopen and receive today's date */
  apply: boolean;
  status: "Reopen" | null;
  /** DD-MM-YYYY when apply is true */
  newDate: string | null;
  /** Never create a new row for Reopen */
  createRow: false;
}

/**
 * Decide whether a Master row should get Column K=Reopen + Date=today.
 * Pure — does not mutate workbooks.
 */
export function decideReopenDateUpdate(options: {
  existsInNewSheet: boolean;
  existsInMasterSheet: boolean;
  existingMasterStatus: string | null | undefined;
  /** Processing date already formatted DD-MM-YYYY */
  todayDDMMYYYY: string;
}): ReopenDateUpdateDecision {
  const resolution = resolveLateralJobStatus({
    existsInNewSheet: options.existsInNewSheet,
    existsInMasterSheet: options.existsInMasterSheet,
    existingMasterStatus: options.existingMasterStatus,
  });

  if (
    resolution?.status === "Reopen" &&
    resolution.updateDate === true &&
    resolution.createRow === false
  ) {
    if (!isValidReopenDateFormat(options.todayDDMMYYYY)) {
      throw new Error(
        `Reopen date must be ${REOPEN_DATE_FORMAT} (got "${options.todayDDMMYYYY}").`
      );
    }
    return {
      apply: true,
      status: "Reopen",
      newDate: options.todayDDMMYYYY.trim(),
      createRow: false,
    };
  }

  return {
    apply: false,
    status: null,
    newDate: null,
    createRow: false,
  };
}

export interface ReopenDateRowSnapshot {
  jobRequisitionId: string;
  masterRowNumber: number;
  /** Previous Column K */
  previousStatus: string;
  /** Previous Date cell (normalized display string) */
  previousDate: string;
}

export interface ReopenDateUpdatePlan {
  jobRequisitionId: string;
  masterRowNumber: number;
  previousStatus: string;
  previousDate: string;
  newStatus: "Reopen";
  newDate: string;
}

/**
 * Build reopen date update plans for JRs that qualify.
 * Only Closed → Reopen rows are included.
 */
export function planReopenDateUpdates(options: {
  rowsInBothSheets: ReopenDateRowSnapshot[];
  todayDDMMYYYY: string;
}): ReopenDateUpdatePlan[] {
  const plans: ReopenDateUpdatePlan[] = [];

  for (const row of options.rowsInBothSheets) {
    const decision = decideReopenDateUpdate({
      existsInNewSheet: true,
      existsInMasterSheet: true,
      existingMasterStatus: row.previousStatus,
      todayDDMMYYYY: options.todayDDMMYYYY,
    });
    if (!decision.apply || !decision.newDate) continue;
    plans.push({
      jobRequisitionId: row.jobRequisitionId,
      masterRowNumber: row.masterRowNumber,
      previousStatus: row.previousStatus,
      previousDate: row.previousDate,
      newStatus: "Reopen",
      newDate: decision.newDate,
    });
  }

  return plans;
}

export interface ReopenDateValidationInput {
  /** Normalized JR ids that were reopened */
  reopenedIds: string[];
  /** Processing date DD-MM-YYYY */
  todayDDMMYYYY: string;
  /** After reconcile (status rules, before NEW inserts): row → Date string */
  dateByMasterRow: Record<number, string>;
  /** After: row → Column K */
  statusByMasterRow: Record<number, string>;
  /** Before status rules: row → Date string */
  dateBeforeByMasterRow: Record<number, string>;
  /** Master row numbers for Active updates (in both, was not Closed) */
  activeMasterRows: number[];
  /** Master row numbers for Closed updates (Master only) */
  closedMasterRows: number[];
  /** Reopen plans applied */
  plans: ReopenDateUpdatePlan[];
}

export interface ReopenDateValidationResult {
  ok: boolean;
  reasons: string[];
  checks: {
    columnKIsReopen: boolean;
    dateIsTodayDDMMYYYY: boolean;
    noDuplicateRow: boolean;
    activeDatesUntouched: boolean;
    closedAbsentDatesUntouched: boolean;
    onlyReopenedGotDateUpdate: boolean;
  };
}

/**
 * Validate that only reopened JRs received the current date update.
 */
export function validateReopenDateUpdates(
  input: ReopenDateValidationInput
): ReopenDateValidationResult {
  const reasons: string[] = [];
  let columnKIsReopen = true;
  let dateIsTodayDDMMYYYY = true;
  let noDuplicateRow = true;
  let activeDatesUntouched = true;
  let closedAbsentDatesUntouched = true;
  let onlyReopenedGotDateUpdate = true;

  if (!isValidReopenDateFormat(input.todayDDMMYYYY)) {
    dateIsTodayDDMMYYYY = false;
    reasons.push(
      `Processing date must be ${REOPEN_DATE_FORMAT} (got "${input.todayDDMMYYYY}").`
    );
  }

  const reopenedRows = new Set<number>();

  for (const id of input.reopenedIds) {
    const plan = input.plans.find((p) => p.jobRequisitionId === id);
    if (!plan) {
      columnKIsReopen = false;
      reasons.push(`Missing reopen plan for JR "${id}".`);
      continue;
    }
    reopenedRows.add(plan.masterRowNumber);

    const status = (input.statusByMasterRow[plan.masterRowNumber] ?? "").trim();
    if (status !== "Reopen") {
      columnKIsReopen = false;
      reasons.push(
        `Master Sheet Column K for reopened JR "${id}" (row ${plan.masterRowNumber}) must be "Reopen" (found "${status || "(empty)"}").`
      );
    }

    const date = (input.dateByMasterRow[plan.masterRowNumber] ?? "").trim();
    if (date !== input.todayDDMMYYYY.trim()) {
      dateIsTodayDDMMYYYY = false;
      reasons.push(
        `Reopened JR "${id}" Date must be "${input.todayDDMMYYYY}" (found "${date || "(empty)"}").`
      );
    }
    if (!isValidReopenDateFormat(date)) {
      dateIsTodayDDMMYYYY = false;
      reasons.push(
        `Reopened JR "${id}" Date must be ${REOPEN_DATE_FORMAT} (found "${date || "(empty)"}").`
      );
    }

    // No duplicate: plan targets a single existing row
    if (plan.masterRowNumber < 2) {
      noDuplicateRow = false;
      reasons.push(`Invalid Master row for reopen of "${id}".`);
    }
  }

  for (const row of input.activeMasterRows) {
    const before = (input.dateBeforeByMasterRow[row] ?? "").trim();
    const after = (input.dateByMasterRow[row] ?? "").trim();
    if (before !== after) {
      activeDatesUntouched = false;
      onlyReopenedGotDateUpdate = false;
      reasons.push(
        `Active Master row ${row} Date was modified (before "${before}", after "${after}"). Active rows must keep their date.`
      );
    }
  }

  for (const row of input.closedMasterRows) {
    const before = (input.dateBeforeByMasterRow[row] ?? "").trim();
    const after = (input.dateByMasterRow[row] ?? "").trim();
    if (before !== after) {
      closedAbsentDatesUntouched = false;
      onlyReopenedGotDateUpdate = false;
      reasons.push(
        `Closed (absent from New Sheet) Master row ${row} Date was modified (before "${before}", after "${after}").`
      );
    }
  }

  // Any non-reopened row whose date changed is a failure
  for (const [rowStr, beforeRaw] of Object.entries(input.dateBeforeByMasterRow)) {
    const row = Number(rowStr);
    if (reopenedRows.has(row)) continue;
    const before = (beforeRaw ?? "").trim();
    const after = (input.dateByMasterRow[row] ?? "").trim();
    if (before !== after) {
      onlyReopenedGotDateUpdate = false;
      reasons.push(
        `Unrelated Master row ${row} Date changed during reopen processing (before "${before}", after "${after}").`
      );
    }
  }

  const ok =
    columnKIsReopen &&
    dateIsTodayDDMMYYYY &&
    noDuplicateRow &&
    activeDatesUntouched &&
    closedAbsentDatesUntouched &&
    onlyReopenedGotDateUpdate;

  return {
    ok,
    reasons,
    checks: {
      columnKIsReopen,
      dateIsTodayDDMMYYYY,
      noDuplicateRow,
      activeDatesUntouched,
      closedAbsentDatesUntouched,
      onlyReopenedGotDateUpdate,
    },
  };
}

export {
  MASTER_DATE_HEADER,
  MASTER_JOB_STATUS_COLUMN_K,
  MASTER_JOB_STATUS_HEADER,
};
