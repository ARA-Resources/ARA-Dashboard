/**
 * Robust Lateral pipeline failure handling.
 *
 * Rules for EVERY failure:
 *  1. Stop processing
 *  2. Do not continue to later stages
 *  3. Do not update the Gmail checkpoint
 *  4. Preserve the last successful Master Workbook version
 *  5. Log the exact failed stage
 *  6. Show a human-readable error
 *  7. Allow the next scheduled run to retry
 *
 * Never report success when any hard stage failed.
 */
export const LATERAL_FAILURE_CODES = [
  "GMAIL_AUTHENTICATION_FAILURE",
  "GMAIL_SEARCH_FAILURE",
  "NO_MATCHING_EMAIL",
  "EXCEL_ATTACHMENT_MISSING",
  "INVALID_EXCEL_FILE",
  "ATCI_DS_MISSING",
  "GOOGLE_DRIVE_AUTHENTICATION_FAILURE",
  "GOOGLE_DRIVE_UPLOAD_FAILURE",
  "MASTER_WORKBOOK_MISSING",
  "MASTER_SHEET_MISSING",
  "NEW_SHEET_MISSING",
  "HEADER_MISMATCH",
  "DUPLICATE_JR_IDS",
  "EXCEL_PROCESSING_FAILURE",
  "NEW_SHEET_UPDATE_FAILURE",
  "MASTER_SHEET_UPDATE_FAILURE",
  "STATUS_RECONCILIATION_FAILURE",
  "POSTED_PROCESSING_FAILURE",
  "P_ROLES_REFRESH_FAILURE",
  "XLSM_SAVE_FAILURE",
  "GOOGLE_DRIVE_FINAL_UPDATE_FAILURE",
  "UNKNOWN_FAILURE",
] as const;

export type LateralFailureCode = (typeof LATERAL_FAILURE_CODES)[number];

/** Stages that participate in the Lateral end-to-end job */
export const LATERAL_FAILURE_STAGES = [
  "gmail_authentication",
  "gmail_search",
  "gmail_email_match",
  "excel_attachment",
  "excel_download",
  "excel_validation",
  "drive_authentication",
  "drive_upload",
  "atci_ds",
  "master_workbook",
  "master_sheet",
  "new_sheet",
  "header_structure",
  "jr_comparison",
  "excel_processing",
  "new_sheet_update",
  "master_sheet_update",
  "status_reconciliation",
  "posted_processing",
  "p_roles_refresh",
  "xlsm_save",
  "drive_final_update",
  "pipeline",
  "job",
] as const;

export type LateralFailureStage = (typeof LATERAL_FAILURE_STAGES)[number];

export interface LateralStageFailure {
  ok: false;
  code: LateralFailureCode;
  stage: LateralFailureStage;
  /** Human-readable error for UI / notifications */
  message: string;
  /** Exact failed stage label for logs */
  failedStage: string;
  /** Always false on failure */
  checkpointAdvanced: false;
  /** Last successful Master must remain untouched / restorable */
  previousMasterPreserved: true;
  /** Next scheduled run may retry the same email */
  retryable: true;
  /** Never report overall success when this is set */
  reportedSuccess: false;
  /**
   * NO_MATCHING_EMAIL is a clear terminal state but not a hard failure
   * (job may complete successfully with no work).
   */
  isHardFailure: boolean;
  detail?: string;
  at: string;
}

const HUMAN_MESSAGES: Record<LateralFailureCode, string> = {
  GMAIL_AUTHENTICATION_FAILURE:
    "Gmail authentication failed. Reconnect Google / Gmail OAuth and try again.",
  GMAIL_SEARCH_FAILURE:
    "Gmail search failed. Check Gmail API access and Lateral keywords, then retry.",
  NO_MATCHING_EMAIL:
    "No matching Lateral Excel email was found after the current checkpoint. Nothing to process.",
  EXCEL_ATTACHMENT_MISSING:
    "A matching email was found but no valid Excel attachment (.xlsx/.xlsm/.xls) was present.",
  INVALID_EXCEL_FILE:
    "The Excel attachment could not be opened or is invalid. Checkpoint was not advanced so the next run can retry.",
  ATCI_DS_MISSING:
    'The "ATCI DS" worksheet was not found in the source workbook. Processing stopped.',
  GOOGLE_DRIVE_AUTHENTICATION_FAILURE:
    "Google Drive authentication failed. Reconnect Google Drive access and try again.",
  GOOGLE_DRIVE_UPLOAD_FAILURE:
    "Uploading the Excel file to Google Drive failed. The Gmail checkpoint was not advanced.",
  MASTER_WORKBOOK_MISSING:
    'Master Workbook "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm" was not found. Processing stopped.',
  MASTER_SHEET_MISSING:
    'The "Master Sheet" worksheet is missing from the Master Workbook. Processing stopped.',
  NEW_SHEET_MISSING:
    'The "New Sheet" worksheet is missing from the Master Workbook. Processing stopped.',
  HEADER_MISMATCH:
    "New Sheet headers do not match the required A–J structure. Processing stopped; headers were not rearranged.",
  DUPLICATE_JR_IDS:
    "Duplicate Job Requisition IDs were found. Processing stopped before status changes.",
  EXCEL_PROCESSING_FAILURE:
    "Excel processing failed while reading or preparing source data. Processing stopped.",
  NEW_SHEET_UPDATE_FAILURE:
    "Updating New Sheet failed. The previous Master Workbook version was preserved.",
  MASTER_SHEET_UPDATE_FAILURE:
    "Updating Master Sheet failed. The previous Master Workbook version was preserved.",
  STATUS_RECONCILIATION_FAILURE:
    "Job Status reconciliation failed. Column K was not finalized; checkpoint was not advanced.",
  POSTED_PROCESSING_FAILURE:
    "Posted Sheet matching failed. Master Sheet Column M was not changed; Column K / Job Status was not modified.",
  P_ROLES_REFRESH_FAILURE:
    "P-Roles PivotTable refresh failed. Master Sheet and Column K were not modified; the existing PivotTable was not rebuilt.",
  XLSM_SAVE_FAILURE:
    "Saving the Master Workbook as XLSM failed. VBA project and prior Master version were preserved where possible.",
  GOOGLE_DRIVE_FINAL_UPDATE_FAILURE:
    "Final Google Drive update of the Master Workbook failed. Checkpoint was not advanced; next run can retry.",
  UNKNOWN_FAILURE:
    "Lateral processing failed unexpectedly. Checkpoint was not advanced; next run can retry.",
};

const STAGE_LABELS: Record<LateralFailureStage, string> = {
  gmail_authentication: "Gmail authentication",
  gmail_search: "Gmail search",
  gmail_email_match: "Gmail email match",
  excel_attachment: "Excel attachment",
  excel_download: "Excel download",
  excel_validation: "Excel validation",
  drive_authentication: "Google Drive authentication",
  drive_upload: "Google Drive upload",
  atci_ds: "ATCI DS worksheet",
  master_workbook: "Master Workbook discovery",
  master_sheet: "Master Sheet",
  new_sheet: "New Sheet",
  header_structure: "New Sheet header structure",
  jr_comparison: "Job Requisition comparison",
  excel_processing: "Excel processing",
  new_sheet_update: "New Sheet update",
  master_sheet_update: "Master Sheet update",
  status_reconciliation: "Status reconciliation",
  posted_processing: "Posted Sheet matching",
  p_roles_refresh: "P-Roles PivotTable refresh",
  xlsm_save: "XLSM save",
  drive_final_update: "Google Drive final Master update",
  pipeline: "Lateral Dataset pipeline",
  job: "Lateral Dataset job",
};

export function createLateralStageFailure(options: {
  code: LateralFailureCode;
  stage: LateralFailureStage;
  detail?: string;
  messageOverride?: string;
}): LateralStageFailure {
  const base = HUMAN_MESSAGES[options.code];
  const message = options.messageOverride?.trim()
    ? options.messageOverride.trim()
    : options.detail?.trim()
      ? `${base} ${options.detail.trim()}`
      : base;

  return {
    ok: false,
    code: options.code,
    stage: options.stage,
    message,
    failedStage: STAGE_LABELS[options.stage],
    checkpointAdvanced: false,
    previousMasterPreserved: true,
    retryable: true,
    reportedSuccess: false,
    isHardFailure: options.code !== "NO_MATCHING_EMAIL",
    detail: options.detail,
    at: new Date().toISOString(),
  };
}

/** Classify sync / pipeline error text into a failure code + stage. */
export function classifyLateralFailure(input: {
  error?: string | null;
  syncItemStatus?: string | null;
  pipelineFailedStep?: number | null;
  phase?: string | null;
}): { code: LateralFailureCode; stage: LateralFailureStage } {
  const err = (input.error || "").toLowerCase();
  const status = (input.syncItemStatus || "").toLowerCase();
  const phase = (input.phase || "").toLowerCase();
  const step = input.pipelineFailedStep ?? null;

  if (status === "source_sheet_missing" || /atci ds/.test(err)) {
    return { code: "ATCI_DS_MISSING", stage: "atci_ds" };
  }
  if (status === "new_sheet_structure_failed" || /header/.test(err)) {
    return { code: "HEADER_MISMATCH", stage: "header_structure" };
  }
  if (status === "master_discovery_failed") {
    if (/master sheet/.test(err) && /not found|missing/.test(err)) {
      return { code: "MASTER_SHEET_MISSING", stage: "master_sheet" };
    }
    if (/new sheet/.test(err) && /not found|missing/.test(err)) {
      return { code: "NEW_SHEET_MISSING", stage: "new_sheet" };
    }
    return { code: "MASTER_WORKBOOK_MISSING", stage: "master_workbook" };
  }
  if (status === "source_read_failed") {
    return { code: "EXCEL_PROCESSING_FAILURE", stage: "excel_processing" };
  }
  if (status === "validation_failed" || status === "download_failed") {
    if (/auth|oauth|login|credential|token|401|403/.test(err) && status === "download_failed") {
      return { code: "GMAIL_AUTHENTICATION_FAILURE", stage: "gmail_authentication" };
    }
    if (status === "validation_failed") {
      return { code: "INVALID_EXCEL_FILE", stage: "excel_validation" };
    }
  }
  if (status === "upload_failed" || status === "download_failed") {
    if (/auth|oauth|login|credential|token|401|403/.test(err)) {
      return {
        code: status === "upload_failed"
          ? "GOOGLE_DRIVE_AUTHENTICATION_FAILURE"
          : "GMAIL_AUTHENTICATION_FAILURE",
        stage: status === "upload_failed" ? "drive_authentication" : "gmail_authentication",
      };
    }
    return status === "upload_failed"
      ? { code: "GOOGLE_DRIVE_UPLOAD_FAILURE", stage: "drive_upload" }
      : { code: "INVALID_EXCEL_FILE", stage: "excel_download" };
  }
  if (status === "no_excel_attachment") {
    return { code: "EXCEL_ATTACHMENT_MISSING", stage: "excel_attachment" };
  }

  if (/oauth|not connected|gmail.*auth|invalid_grant|login required/.test(err)) {
    if (/drive/.test(err)) {
      return {
        code: "GOOGLE_DRIVE_AUTHENTICATION_FAILURE",
        stage: "drive_authentication",
      };
    }
    return { code: "GMAIL_AUTHENTICATION_FAILURE", stage: "gmail_authentication" };
  }
  if (/gmail.*search|list.*messages|users\.messages/.test(err)) {
    return { code: "GMAIL_SEARCH_FAILURE", stage: "gmail_search" };
  }
  if (/duplicate.*job requisition|duplicate jr/.test(err)) {
    return { code: "DUPLICATE_JR_IDS", stage: "jr_comparison" };
  }
  if (/atci ds/.test(err)) {
    return { code: "ATCI_DS_MISSING", stage: "atci_ds" };
  }
  if (/header mismatch|headers? (do not|don't) match|exact a–j|exact a-j/.test(err)) {
    return { code: "HEADER_MISMATCH", stage: "header_structure" };
  }
  if (/posted sheet|posted matching|column m/.test(err)) {
    return { code: "POSTED_PROCESSING_FAILURE", stage: "posted_processing" };
  }
  if (/p-roles|pivottable|pivot refresh/.test(err)) {
    return { code: "P_ROLES_REFRESH_FAILURE", stage: "p_roles_refresh" };
  }
  if (/master workbook/.test(err) && /not found|missing/.test(err)) {
    return { code: "MASTER_WORKBOOK_MISSING", stage: "master_workbook" };
  }
  if (/master sheet/.test(err) && /not found|missing/.test(err)) {
    return { code: "MASTER_SHEET_MISSING", stage: "master_sheet" };
  }
  if (/new sheet/.test(err) && /not found|missing/.test(err)) {
    return { code: "NEW_SHEET_MISSING", stage: "new_sheet" };
  }

  if (phase === "validation" || phase === "reconciliation") {
    return { code: "STATUS_RECONCILIATION_FAILURE", stage: "status_reconciliation" };
  }
  if (phase === "backup" || phase === "save") {
    return { code: "XLSM_SAVE_FAILURE", stage: "xlsm_save" };
  }
  if (phase === "macro") {
    return { code: "GOOGLE_DRIVE_FINAL_UPDATE_FAILURE", stage: "drive_final_update" };
  }

  if (step != null) {
    if (step <= 3) return { code: "EXCEL_PROCESSING_FAILURE", stage: "excel_processing" };
    if (step === 4) return { code: "ATCI_DS_MISSING", stage: "atci_ds" };
    if (step === 5) return { code: "EXCEL_PROCESSING_FAILURE", stage: "excel_processing" };
    if (step === 6) return { code: "MASTER_WORKBOOK_MISSING", stage: "master_workbook" };
    if (step === 7) {
      return /new sheet/i.test(err)
        ? { code: "NEW_SHEET_MISSING", stage: "new_sheet" }
        : { code: "MASTER_SHEET_MISSING", stage: "master_sheet" };
    }
    if (step === 8) return { code: "HEADER_MISMATCH", stage: "header_structure" };
    if (step === 9) return { code: "EXCEL_PROCESSING_FAILURE", stage: "excel_processing" };
    if (step >= 10 && step <= 13) {
      return { code: "NEW_SHEET_UPDATE_FAILURE", stage: "new_sheet_update" };
    }
    if (step === 14) return { code: "DUPLICATE_JR_IDS", stage: "jr_comparison" };
    if (step >= 15 && step <= 17) {
      return { code: "STATUS_RECONCILIATION_FAILURE", stage: "status_reconciliation" };
    }
    if (step === 18) {
      return { code: "POSTED_PROCESSING_FAILURE", stage: "posted_processing" };
    }
    if (step === 19) {
      return { code: "P_ROLES_REFRESH_FAILURE", stage: "p_roles_refresh" };
    }
    if (step >= 20 && step <= 23) {
      return { code: "XLSM_SAVE_FAILURE", stage: "xlsm_save" };
    }
    if (step >= 24) {
      return {
        code: "GOOGLE_DRIVE_FINAL_UPDATE_FAILURE",
        stage: "drive_final_update",
      };
    }
  }

  if (/final.*drive|destination folder|drive update/.test(err)) {
    return {
      code: "GOOGLE_DRIVE_FINAL_UPDATE_FAILURE",
      stage: "drive_final_update",
    };
  }
  if (/xlsm|final save|vba/.test(err)) {
    return { code: "XLSM_SAVE_FAILURE", stage: "xlsm_save" };
  }
  if (/reconcil|column k|job status/.test(err)) {
    return { code: "STATUS_RECONCILIATION_FAILURE", stage: "status_reconciliation" };
  }
  if (/new sheet/.test(err)) {
    return { code: "NEW_SHEET_UPDATE_FAILURE", stage: "new_sheet_update" };
  }
  if (/master sheet/.test(err)) {
    return { code: "MASTER_SHEET_UPDATE_FAILURE", stage: "master_sheet_update" };
  }
  if (/upload/.test(err)) {
    return { code: "GOOGLE_DRIVE_UPLOAD_FAILURE", stage: "drive_upload" };
  }

  return { code: "UNKNOWN_FAILURE", stage: "job" };
}

/**
 * Success is forbidden when a hard failure exists or checkpoint was incorrectly advanced.
 */
export function assertNeverReportSuccessOnFailure(options: {
  hardFailure: LateralStageFailure | null;
  checkpointAdvanced: boolean;
  claimedSuccess: boolean;
}): { ok: boolean; reason?: string } {
  if (options.hardFailure?.isHardFailure && options.claimedSuccess) {
    return {
      ok: false,
      reason: `Cannot report success after hard failure at ${options.hardFailure.failedStage} (${options.hardFailure.code}).`,
    };
  }
  if (options.hardFailure?.isHardFailure && options.checkpointAdvanced) {
    return {
      ok: false,
      reason: `Cannot advance checkpoint after hard failure at ${options.hardFailure.failedStage}.`,
    };
  }
  if (
    options.hardFailure &&
    options.hardFailure.checkpointAdvanced !== false
  ) {
    return { ok: false, reason: "Failure object must keep checkpointAdvanced=false." };
  }
  if (
    options.hardFailure &&
    options.hardFailure.previousMasterPreserved !== true
  ) {
    return {
      ok: false,
      reason: "Failure object must keep previousMasterPreserved=true.",
    };
  }
  return { ok: true };
}

export function formatLateralFailureForLog(
  failure: LateralStageFailure
): Record<string, unknown> {
  return {
    event: "lateral_stage_failure",
    at: failure.at,
    code: failure.code,
    stage: failure.stage,
    failedStage: failure.failedStage,
    message: failure.message,
    detail: failure.detail ?? null,
    checkpointAdvanced: false,
    previousMasterPreserved: true,
    retryable: true,
    reportedSuccess: false,
    isHardFailure: failure.isHardFailure,
  };
}
