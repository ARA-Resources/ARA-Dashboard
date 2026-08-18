/**
 * Final Lateral Job Status rules for Master Sheet Column K.
 *
 * Allowed values ONLY: Active | Closed | Reopen | New
 * Matching key: Job Requisition ID
 * Status is written ONLY to Master Sheet (never New Sheet).
 */
export const ALLOWED_MASTER_JOB_STATUSES = [
  "Active",
  "Closed",
  "Reopen",
  "New",
] as const;

export type LateralMasterJobStatus = (typeof ALLOWED_MASTER_JOB_STATUSES)[number];

/** Excel column K (1-based) — Job Status is ALWAYS stored here on Master Sheet. */
export const MASTER_JOB_STATUS_COLUMN_K = 11;

/**
 * Columns that may contain status-like filter values and must NOT trigger
 * "status outside Column K" leakage failures.
 * Column L (12) = "Opened on Oorwin" (and similar) filter — not Job Status.
 */
export const MASTER_STATUS_LEAK_IGNORED_COLUMNS = [12] as const;

export const MASTER_JOB_STATUS_HEADER = "Job Status";
export const JOB_REQUISITION_ID_HEADER = "Job Requisition ID";
export const MASTER_DATE_HEADER = "Date";

export type LateralStatusAction = "Activated" | "Reopened" | "Closed" | "Added";

export interface LateralStatusResolution {
  status: LateralMasterJobStatus;
  action: LateralStatusAction;
  /** Update Master Sheet Date to current processing date (DD-MM-YYYY) */
  updateDate: boolean;
  /** Append a new Master Sheet row (NEW only) */
  createRow: boolean;
}

/**
 * Resolve the final Master Sheet Job Status for one JR.
 * Does not mutate workbooks — pure rule evaluation.
 */
export function resolveLateralJobStatus(options: {
  existsInNewSheet: boolean;
  existsInMasterSheet: boolean;
  /** Existing Master Sheet Column K value (trimmed); ignored when creating NEW */
  existingMasterStatus?: string | null;
}): LateralStatusResolution | null {
  const inNew = options.existsInNewSheet;
  const inMaster = options.existsInMasterSheet;
  const existing = (options.existingMasterStatus ?? "").trim();

  // RULE 4 — NEW
  if (inNew && !inMaster) {
    return {
      status: "New",
      action: "Added",
      updateDate: false,
      createRow: true,
    };
  }

  // RULE 3 — CLOSED
  if (!inNew && inMaster) {
    return {
      status: "Closed",
      action: "Closed",
      updateDate: false,
      createRow: false,
    };
  }

  // RULE 1 / 2 — in both sheets
  if (inNew && inMaster) {
    if (existing === "Closed") {
      // RULE 2 — REOPEN
      return {
        status: "Reopen",
        action: "Reopened",
        updateDate: true,
        createRow: false,
      };
    }
    // RULE 1 — ACTIVE (existing is NOT Closed)
    return {
      status: "Active",
      action: "Activated",
      updateDate: false,
      createRow: false,
    };
  }

  return null;
}

export function isAllowedMasterJobStatus(
  value: string
): value is LateralMasterJobStatus {
  return (ALLOWED_MASTER_JOB_STATUSES as readonly string[]).includes(value);
}
