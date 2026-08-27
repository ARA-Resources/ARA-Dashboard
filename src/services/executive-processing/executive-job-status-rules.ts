/**
 * Executive Master Sheet Job Status rules (Phase 4C).
 *
 * Evidence / mapping:
 * - Lateral: resolveLateralJobStatus (lateral-job-status-rules.ts)
 * - Phase 4C requirement: Active | New | Reopen | Closed
 * - Excel VBA UpdateDemandSheetStatus_Exec historically used Active/Closed only
 *   (no Reopen). Phase 4C intentionally adopts Lateral-parity for dashboard
 *   processing that replaces VBA.
 *
 * Match key: Job Requisition ID (trim).
 * Sticky: New / Reopen remain until Job Status is changed manually.
 * Closed: Master-only JR → Closed; row is NOT deleted.
 */

export const EXECUTIVE_ALLOWED_JOB_STATUSES = [
  "Active",
  "Closed",
  "Reopen",
  "New",
] as const;

export type ExecutiveMasterJobStatus =
  (typeof EXECUTIVE_ALLOWED_JOB_STATUSES)[number];

export type ExecutiveStatusAction =
  | "Activated"
  | "Reopened"
  | "Closed"
  | "Added"
  | "Unchanged";

export interface ExecutiveStatusResolution {
  status: ExecutiveMasterJobStatus;
  action: ExecutiveStatusAction;
  /** Update Date of New JR to processing date (Closed → Reopen only). */
  updateDateOfNewJr: boolean;
  createRow: boolean;
}

export function normalizeExecutiveJobRequisitionId(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\u00a0/g, " ")
    .trim();
}

/**
 * Resolve Executive Master Job Status for one JR (pure).
 */
export function resolveExecutiveJobStatus(options: {
  existsInNewSheet: boolean;
  existsInMasterSheet: boolean;
  existingMasterStatus?: string | null;
}): ExecutiveStatusResolution | null {
  const inNew = options.existsInNewSheet;
  const inMaster = options.existsInMasterSheet;
  const existing = (options.existingMasterStatus ?? "").trim();

  // RULE 4 — NEW
  if (inNew && !inMaster) {
    return {
      status: "New",
      action: "Added",
      updateDateOfNewJr: false,
      createRow: true,
    };
  }

  // RULE 3 — CLOSED
  if (!inNew && inMaster) {
    return {
      status: "Closed",
      action: "Closed",
      updateDateOfNewJr: false,
      createRow: false,
    };
  }

  // RULE 1 / 2 — in both
  if (inNew && inMaster) {
    if (existing === "Closed") {
      return {
        status: "Reopen",
        action: "Reopened",
        updateDateOfNewJr: true,
        createRow: false,
      };
    }
    if (existing === "New") {
      return {
        status: "New",
        action: "Unchanged",
        updateDateOfNewJr: false,
        createRow: false,
      };
    }
    if (existing === "Reopen") {
      return {
        status: "Reopen",
        action: "Unchanged",
        updateDateOfNewJr: false,
        createRow: false,
      };
    }
    return {
      status: "Active",
      action: "Activated",
      updateDateOfNewJr: false,
      createRow: false,
    };
  }

  return null;
}

export function formatExecutiveProcessingDateDDMMYYYY(
  date: Date = new Date()
): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  return `${dd}-${mm}-${yyyy}`;
}
