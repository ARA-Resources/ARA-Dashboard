/**
 * Complete Lateral status reconciliation validation.
 *
 * For every Master Sheet Job Requisition ID after reconcile, verify:
 *   presence in New / Master, previous status, final status, correct action.
 *
 * Counts: Active | Closed | Reopen | New
 * Actions: new rows added | reopened | closed | remaining active
 *
 * Per-status Column K checks + Reopen date = today (DD-MM-YYYY).
 * Status values Active|Closed|Reopen|New may exist ONLY in Master Sheet Column K.
 * Do not report success until validation passes.
 */
import {
  ALLOWED_MASTER_JOB_STATUSES,
  JOB_REQUISITION_ID_HEADER,
  MASTER_DATE_HEADER,
  MASTER_JOB_STATUS_COLUMN_K,
  MASTER_JOB_STATUS_HEADER,
  MASTER_STATUS_LEAK_IGNORED_COLUMNS,
  resolveLateralJobStatus,
  type LateralMasterJobStatus,
  type LateralStatusAction,
  isAllowedMasterJobStatus,
} from "@/services/lateral-processing/lateral-job-status-rules";
import { isValidReopenDateFormat } from "@/services/lateral-processing/lateral-reopen-date-update";

export interface StatusReconciliationJrInput {
  jobRequisitionId: string;
  masterRowNumber: number;
  /** True if JR was in New Sheet during this reconcile */
  presentInNewSheet: boolean;
  /**
   * True if JR existed in Master Sheet BEFORE reconcile.
   * False for newly appended rows.
   */
  presentInMasterSheetBefore: boolean;
  /** Column K before reconcile (empty / Not Found for NEW) */
  previousStatus: string;
  /** Column K after reconcile */
  finalStatus: string;
  /** Date column after reconcile (normalized DD-MM-YYYY when possible) */
  finalDate: string;
  /** Reported action from reconcile details, if any */
  reportedAction?: string;
}

export interface StatusReconciliationJrResult {
  jobRequisitionId: string;
  masterRowNumber: number;
  presentInNewSheet: boolean;
  presentInMasterSheet: boolean;
  previousStatus: string;
  finalStatus: string;
  expectedStatus: LateralMasterJobStatus | null;
  expectedAction: LateralStatusAction | null;
  reportedAction: string;
  actionCorrect: boolean;
  columnKCorrect: boolean;
  dateCorrect: boolean;
  ok: boolean;
  reasons: string[];
}

export interface StatusReconciliationCounts {
  Active: number;
  Closed: number;
  Reopen: number;
  New: number;
}

export interface StatusReconciliationActionCounts {
  newRowsAdded: number;
  reopenedRows: number;
  rowsClosed: number;
  rowsRemainingActive: number;
}

export interface StatusLeakFinding {
  masterRowNumber: number;
  column: number;
  header: string;
  value: string;
  jobRequisitionId: string;
}

export interface CompleteStatusReconciliationValidationInput {
  /** Every Master Sheet JR after reconcile */
  masterRows: StatusReconciliationJrInput[];
  /** Processing date DD-MM-YYYY */
  todayDDMMYYYY: string;
  /**
   * Optional full Master Sheet cell scan for status leakage.
   * row → col → value (1-based cols). Column K is allowed to hold statuses.
   */
  masterCellsByRow?: Record<number, Record<number, string>>;
  /** Optional header map col → header for leak messages */
  masterHeadersByCol?: Record<number, string>;
}

export interface CompleteStatusReconciliationValidationResult {
  ok: boolean;
  reasons: string[];
  jrResults: StatusReconciliationJrResult[];
  statusCounts: StatusReconciliationCounts;
  actionCounts: StatusReconciliationActionCounts;
  statusLeakFindings: StatusLeakFinding[];
  checks: {
    everyJrValidated: boolean;
    statusCountsMatchRows: boolean;
    columnKPerStatus: boolean;
    reopenDatesAreToday: boolean;
    statusesOnlyInColumnK: boolean;
    actionsCorrect: boolean;
  };
}

function normalizeStatus(value: string): string {
  return (value ?? "").trim();
}

function expectedFromPresence(row: StatusReconciliationJrInput) {
  return resolveLateralJobStatus({
    existsInNewSheet: row.presentInNewSheet,
    existsInMasterSheet: row.presentInMasterSheetBefore,
    existingMasterStatus: row.previousStatus,
  });
}

function actionForStatus(status: LateralMasterJobStatus): LateralStatusAction {
  switch (status) {
    case "Active":
      return "Activated";
    case "Reopen":
      return "Reopened";
    case "Closed":
      return "Closed";
    case "New":
      return "Added";
  }
}

/**
 * Scan Master Sheet cells for status values outside Column K.
 */
export function findStatusesOutsideColumnK(options: {
  masterCellsByRow: Record<number, Record<number, string>>;
  masterHeadersByCol?: Record<number, string>;
  jobIdByRow?: Record<number, string>;
  statusColumn?: number;
  /** Extra columns to skip (default includes Column L filter). */
  ignoredColumns?: readonly number[];
}): StatusLeakFinding[] {
  const statusCol = options.statusColumn ?? MASTER_JOB_STATUS_COLUMN_K;
  const ignored = new Set<number>([
    ...MASTER_STATUS_LEAK_IGNORED_COLUMNS,
    ...(options.ignoredColumns ?? []),
  ]);
  const findings: StatusLeakFinding[] = [];
  const allowed = new Set<string>(ALLOWED_MASTER_JOB_STATUSES);

  for (const [rowStr, cells] of Object.entries(options.masterCellsByRow)) {
    const row = Number(rowStr);
    for (const [colStr, raw] of Object.entries(cells)) {
      const col = Number(colStr);
      if (col === statusCol || ignored.has(col)) continue;
      const value = normalizeStatus(raw);
      if (!value || !allowed.has(value)) continue;
      findings.push({
        masterRowNumber: row,
        column: col,
        header:
          options.masterHeadersByCol?.[col] ??
          (col === statusCol ? MASTER_JOB_STATUS_HEADER : `Column ${col}`),
        value,
        jobRequisitionId: options.jobIdByRow?.[row] ?? "",
      });
    }
  }

  return findings;
}

/**
 * Complete post-reconcile validation. Call before reporting success.
 */
export function validateCompleteStatusReconciliation(
  input: CompleteStatusReconciliationValidationInput
): CompleteStatusReconciliationValidationResult {
  const reasons: string[] = [];
  const jrResults: StatusReconciliationJrResult[] = [];

  const statusCounts: StatusReconciliationCounts = {
    Active: 0,
    Closed: 0,
    Reopen: 0,
    New: 0,
  };

  let everyJrValidated = true;
  let columnKPerStatus = true;
  let reopenDatesAreToday = true;
  let actionsCorrect = true;

  if (!isValidReopenDateFormat(input.todayDDMMYYYY)) {
    reopenDatesAreToday = false;
    reasons.push(
      `Processing date must be DD-MM-YYYY (got "${input.todayDDMMYYYY}").`
    );
  }

  for (const row of input.masterRows) {
    const rowReasons: string[] = [];
    const expected = expectedFromPresence(row);
    const final = normalizeStatus(row.finalStatus);
    const previous = normalizeStatus(row.previousStatus) || "Not Found";

    if (!expected) {
      everyJrValidated = false;
      rowReasons.push(
        `JR "${row.jobRequisitionId}" could not resolve an expected status.`
      );
    }

    const expectedStatus = expected?.status ?? null;
    const expectedAction = expected?.action ?? null;
    const reportedAction =
      (row.reportedAction ?? "").trim() ||
      (expectedAction && expectedStatus
        ? actionForStatus(expectedStatus)
        : "");

    let actionCorrect = true;
    if (!expectedStatus || final !== expectedStatus) {
      everyJrValidated = false;
      columnKPerStatus = false;
      rowReasons.push(
        `JR "${row.jobRequisitionId}" final status "${final || "(empty)"}" does not match expected "${expectedStatus ?? "(none)"}" ` +
          `(inNew=${row.presentInNewSheet}, inMasterBefore=${row.presentInMasterSheetBefore}, previous="${previous}").`
      );
    }

    if (expectedAction && reportedAction && reportedAction !== expectedAction) {
      actionCorrect = false;
      actionsCorrect = false;
      rowReasons.push(
        `JR "${row.jobRequisitionId}" action "${reportedAction}" does not match expected "${expectedAction}".`
      );
    }

    let columnKCorrect = true;
    if (!isAllowedMasterJobStatus(final)) {
      columnKCorrect = false;
      columnKPerStatus = false;
      everyJrValidated = false;
      rowReasons.push(
        `JR "${row.jobRequisitionId}" Column K has invalid status "${final || "(empty)"}".`
      );
    } else {
      statusCounts[final] += 1;

      // Explicit Column K checks for each status class
      if (final === "Active" && expectedStatus === "Active") {
        /* Column K = Active ✓ */
      } else if (final === "Closed" && expectedStatus === "Closed") {
        /* Column K = Closed ✓ */
      } else if (final === "Reopen" && expectedStatus === "Reopen") {
        /* Column K = Reopen ✓ */
      } else if (final === "New" && expectedStatus === "New") {
        /* Column K = New ✓ */
      } else if (expectedStatus && final !== expectedStatus) {
        columnKCorrect = false;
        columnKPerStatus = false;
        rowReasons.push(
          `${expectedStatus} JR "${row.jobRequisitionId}" Column K must be "${expectedStatus}" (found "${final}").`
        );
      }
    }

    let dateCorrect = true;
    if (final === "Reopen" || expectedStatus === "Reopen") {
      const date = normalizeStatus(row.finalDate);
      if (date !== input.todayDDMMYYYY.trim()) {
        dateCorrect = false;
        reopenDatesAreToday = false;
        rowReasons.push(
          `Reopened JR "${row.jobRequisitionId}" Date must be "${input.todayDDMMYYYY}" (found "${date || "(empty)"}").`
        );
      }
      if (!isValidReopenDateFormat(date)) {
        dateCorrect = false;
        reopenDatesAreToday = false;
        rowReasons.push(
          `Reopened JR "${row.jobRequisitionId}" Date must be DD-MM-YYYY (found "${date || "(empty)"}").`
        );
      }
    }

    const ok =
      rowReasons.length === 0 &&
      columnKCorrect &&
      dateCorrect &&
      actionCorrect &&
      expectedStatus != null &&
      final === expectedStatus;

    if (!ok) everyJrValidated = false;

    jrResults.push({
      jobRequisitionId: row.jobRequisitionId,
      masterRowNumber: row.masterRowNumber,
      presentInNewSheet: row.presentInNewSheet,
      presentInMasterSheet: true,
      previousStatus: previous,
      finalStatus: final,
      expectedStatus,
      expectedAction,
      reportedAction,
      actionCorrect,
      columnKCorrect,
      dateCorrect,
      ok,
      reasons: rowReasons,
    });

    reasons.push(...rowReasons);
  }

  const actionCounts: StatusReconciliationActionCounts = {
    newRowsAdded: statusCounts.New,
    reopenedRows: statusCounts.Reopen,
    rowsClosed: statusCounts.Closed,
    rowsRemainingActive: statusCounts.Active,
  };

  const counted =
    statusCounts.Active +
    statusCounts.Closed +
    statusCounts.Reopen +
    statusCounts.New;
  const statusCountsMatchRows = counted === input.masterRows.length;
  if (!statusCountsMatchRows) {
    reasons.push(
      `Status counts (${counted}) do not match Master JR row count (${input.masterRows.length}).`
    );
  }

  const jobIdByRow: Record<number, string> = {};
  for (const r of input.masterRows) {
    jobIdByRow[r.masterRowNumber] = r.jobRequisitionId;
  }

  const statusLeakFindings = input.masterCellsByRow
    ? findStatusesOutsideColumnK({
        masterCellsByRow: input.masterCellsByRow,
        masterHeadersByCol: input.masterHeadersByCol,
        jobIdByRow,
      })
    : [];

  const statusesOnlyInColumnK = statusLeakFindings.length === 0;
  if (!statusesOnlyInColumnK) {
    for (const f of statusLeakFindings) {
      reasons.push(
        `Status value "${f.value}" found outside Column K at Master row ${f.masterRowNumber} ` +
          `(${f.header || `col ${f.column}`}` +
          (f.jobRequisitionId ? `, JR "${f.jobRequisitionId}"` : "") +
          "). Statuses Active|Closed|Reopen|New must exist ONLY in Master Sheet Column K."
      );
    }
  }

  const ok =
    everyJrValidated &&
    statusCountsMatchRows &&
    columnKPerStatus &&
    reopenDatesAreToday &&
    statusesOnlyInColumnK &&
    actionsCorrect &&
    reasons.length === 0;

  return {
    ok,
    reasons,
    jrResults,
    statusCounts,
    actionCounts,
    statusLeakFindings,
    checks: {
      everyJrValidated,
      statusCountsMatchRows,
      columnKPerStatus,
      reopenDatesAreToday,
      statusesOnlyInColumnK,
      actionsCorrect,
    },
  };
}

export {
  ALLOWED_MASTER_JOB_STATUSES,
  JOB_REQUISITION_ID_HEADER,
  MASTER_DATE_HEADER,
  MASTER_JOB_STATUS_COLUMN_K,
  MASTER_JOB_STATUS_HEADER,
};
