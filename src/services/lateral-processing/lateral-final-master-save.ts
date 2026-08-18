/**
 * Final Master Workbook save gates.
 *
 * Workbook: Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm
 *
 * - Preserve XLSM (never convert to XLSX)
 * - Do not remove the VBA project
 * - Validate New Sheet + Master Sheet status engine outcomes before save
 * - Create/retain a backup/version before final overwrite where possible
 * - Report success ONLY after the final XLSM is successfully saved
 */
import {
  ALLOWED_MASTER_JOB_STATUSES,
  JOB_REQUISITION_ID_HEADER,
  MASTER_DATE_HEADER,
  MASTER_JOB_STATUS_COLUMN_K,
  MASTER_JOB_STATUS_HEADER,
} from "@/services/lateral-processing/lateral-job-status-rules";
import {
  EXPECTED_NEW_SHEET_HEADERS,
  headersMatchIgnoringCase,
} from "@/services/lateral-processing/lateral-new-sheet-structure";
import { isProcessingDateDDMMYYYY } from "@/services/lateral-processing/lateral-new-sheet-refresh";
import { isXlsmMasterFilename } from "@/services/lateral-processing/lateral-master-workbook-discovery";
import { DEFAULT_LATERAL_MASTER_WORKBOOK_NAME } from "@/types/lateral-processing-setup";

export const FINAL_MASTER_WORKBOOK_NAME = DEFAULT_LATERAL_MASTER_WORKBOOK_NAME;

export interface FinalMasterSaveChecks {
  newSheetUpdated: boolean;
  newSheetHeadersUnchanged: boolean;
  newSheetDatePopulated: boolean;
  jrMappingSuccessful: boolean;
  masterSheetUpdated: boolean;
  columnKValidStatusesOnly: boolean;
  newRowsCorrectlyMapped: boolean;
  reopenRowsHaveCurrentDate: boolean;
  closedRowsRemainInMaster: boolean;
  noDuplicateJrIds: boolean;
  workbookIsXlsm: boolean;
  vbaProjectPreservedHint: boolean;
}

export interface FinalMasterSaveValidationResult {
  ok: boolean;
  reasons: string[];
  checks: FinalMasterSaveChecks;
  counts: {
    newSheetRows: number;
    masterRows: number;
    Active: number;
    Closed: number;
    Reopen: number;
    New: number;
    closedRowsPresent: number;
  };
  fileName: string;
}

export interface FinalMasterSaveWorkbookSnapshot {
  fileName: string;
  /** Lowercase extension including dot */
  extension: string;
  masterSheetName: string;
  newSheetName: string;
  newSheetHeaders: string[];
  /** New Sheet data rows: Date, JR ID, ... */
  newSheetRows: Array<{ date: string; jobRequisitionId: string }>;
  masterHeaders: string[];
  /** Master data rows after reconcile */
  masterRows: Array<{
    rowNumber: number;
    date: string;
    jobRequisitionId: string;
    status: string;
  }>;
  /** True when file is .xlsm path / name */
  isXlsm: boolean;
  /** openpyxl keep_vba loaded without stripping — project still present */
  keepVbaTrue: boolean;
  /** Processing date DD-MM-YYYY used for Reopen checks */
  todayDDMMYYYY: string;
  /** Expected Closed JR ids from reconcile report (optional) */
  expectedClosedIds?: string[];
  /** Expected New JR ids from reconcile report (optional) */
  expectedNewIds?: string[];
}

function normalize(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/**
 * Pure validation of a final Master workbook snapshot before Drive save.
 */
export function validateFinalMasterWorkbookSave(
  snap: FinalMasterSaveWorkbookSnapshot
): FinalMasterSaveValidationResult {
  const reasons: string[] = [];

  const workbookIsXlsm =
    snap.isXlsm &&
    isXlsmMasterFilename(snap.fileName) &&
    snap.extension.toLowerCase() === ".xlsm";
  if (!workbookIsXlsm) {
    reasons.push(
      `Master Workbook must remain XLSM ("${FINAL_MASTER_WORKBOOK_NAME}"). Refusing non-XLSM save for "${snap.fileName}".`
    );
  }

  const vbaProjectPreservedHint = snap.keepVbaTrue === true;
  if (!vbaProjectPreservedHint) {
    reasons.push(
      "VBA project preservation check failed (workbook must be loaded/saved with keep_vba; do not convert to XLSX)."
    );
  }

  let newSheetHeadersUnchanged = true;
  const expected = [...EXPECTED_NEW_SHEET_HEADERS];
  if (snap.newSheetHeaders.length < expected.length) {
    newSheetHeadersUnchanged = false;
    reasons.push(
      `New Sheet headers incomplete (expected ${expected.length}, found ${snap.newSheetHeaders.length}).`
    );
  } else {
    for (let i = 0; i < expected.length; i++) {
      if (!headersMatchIgnoringCase(expected[i], snap.newSheetHeaders[i] ?? "")) {
        newSheetHeadersUnchanged = false;
        reasons.push(
          `New Sheet header column ${i + 1} unchanged check failed: expected "${expected[i]}", found "${normalize(snap.newSheetHeaders[i]) || "(empty)"}".`
        );
      }
    }
  }

  const newSheetUpdated = snap.newSheetRows.length > 0;
  if (!newSheetUpdated) {
    reasons.push("New Sheet was not updated (no data rows found).");
  }

  let newSheetDatePopulated = true;
  for (const row of snap.newSheetRows) {
    if (!isProcessingDateDDMMYYYY(row.date)) {
      newSheetDatePopulated = false;
      reasons.push(
        `New Sheet Date must be DD-MM-YYYY for JR "${row.jobRequisitionId || "(blank)"}" (found "${row.date || "(empty)"}").`
      );
      break;
    }
  }

  const masterHasJr = snap.masterHeaders.some(
    (h) => normalize(h) === JOB_REQUISITION_ID_HEADER
  );
  const masterHasDate = snap.masterHeaders.some(
    (h) => normalize(h) === MASTER_DATE_HEADER
  );
  const statusHeader =
    snap.masterHeaders[MASTER_JOB_STATUS_COLUMN_K - 1] ?? "";
  const masterHasStatusK =
    normalize(statusHeader) === MASTER_JOB_STATUS_HEADER;
  const masterSheetUpdated =
    snap.masterRows.length > 0 && masterHasJr && masterHasDate && masterHasStatusK;
  if (!masterHasJr) {
    reasons.push(`Master Sheet missing "${JOB_REQUISITION_ID_HEADER}".`);
  }
  if (!masterHasDate) {
    reasons.push(`Master Sheet missing "${MASTER_DATE_HEADER}".`);
  }
  if (!masterHasStatusK) {
    reasons.push(
      `Master Sheet Column K must be "${MASTER_JOB_STATUS_HEADER}" (found "${normalize(statusHeader) || "(empty)"}").`
    );
  }
  if (snap.masterRows.length === 0) {
    reasons.push("Master Sheet was not updated (no JR data rows).");
  }

  const allowed = new Set<string>(ALLOWED_MASTER_JOB_STATUSES);
  const counts = {
    newSheetRows: snap.newSheetRows.length,
    masterRows: snap.masterRows.length,
    Active: 0,
    Closed: 0,
    Reopen: 0,
    New: 0,
    closedRowsPresent: 0,
  };

  let columnKValidStatusesOnly = true;
  const jrSeen = new Map<string, number[]>();

  for (const row of snap.masterRows) {
    const status = normalize(row.status);
    const jid = normalize(row.jobRequisitionId);
    if (jid) {
      const list = jrSeen.get(jid) ?? [];
      list.push(row.rowNumber);
      jrSeen.set(jid, list);
    }
    if (!allowed.has(status)) {
      columnKValidStatusesOnly = false;
      reasons.push(
        `Master Sheet Column K for JR "${jid || "(blank)"}" (row ${row.rowNumber}) has invalid status "${status || "(empty)"}". Allowed: ${ALLOWED_MASTER_JOB_STATUSES.join(" | ")}.`
      );
      continue;
    }
    if (status === "Active") counts.Active += 1;
    else if (status === "Closed") {
      counts.Closed += 1;
      counts.closedRowsPresent += 1;
    } else if (status === "Reopen") counts.Reopen += 1;
    else if (status === "New") counts.New += 1;
  }

  let noDuplicateJrIds = true;
  for (const [jid, rows] of jrSeen) {
    if (rows.length > 1) {
      noDuplicateJrIds = false;
      reasons.push(
        `Duplicate Job Requisition ID "${jid}" in Master Sheet (rows ${rows.join(", ")}).`
      );
    }
  }
  const newJrSeen = new Map<string, number>();
  for (const row of snap.newSheetRows) {
    const jid = normalize(row.jobRequisitionId);
    if (!jid) continue;
    newJrSeen.set(jid, (newJrSeen.get(jid) ?? 0) + 1);
  }
  for (const [jid, n] of newJrSeen) {
    if (n > 1) {
      noDuplicateJrIds = false;
      reasons.push(
        `Duplicate Job Requisition ID "${jid}" in New Sheet (${n} times).`
      );
    }
  }

  let jrMappingSuccessful = true;
  for (const row of snap.newSheetRows) {
    const jid = normalize(row.jobRequisitionId);
    if (!jid) continue;
    if (!jrSeen.has(jid)) {
      jrMappingSuccessful = false;
      reasons.push(
        `JR mapping failed: New Sheet JR "${jid}" is missing from Master Sheet after reconcile.`
      );
    }
  }

  let newRowsCorrectlyMapped = true;
  const newStatusIds = snap.masterRows
    .filter((r) => normalize(r.status) === "New")
    .map((r) => normalize(r.jobRequisitionId));
  for (const jid of newStatusIds) {
    if (!newJrSeen.has(jid)) {
      newRowsCorrectlyMapped = false;
      reasons.push(
        `New row incorrectly mapped: Master JR "${jid}" has Column K=New but is not in New Sheet.`
      );
    }
  }
  if (snap.expectedNewIds) {
    for (const id of snap.expectedNewIds) {
      const jid = normalize(id);
      const row = snap.masterRows.find(
        (r) => normalize(r.jobRequisitionId) === jid
      );
      if (!row || normalize(row.status) !== "New") {
        newRowsCorrectlyMapped = false;
        reasons.push(
          `Expected New JR "${jid}" missing or Column K is not "New".`
        );
      }
    }
  }

  let reopenRowsHaveCurrentDate = true;
  for (const row of snap.masterRows) {
    if (normalize(row.status) !== "Reopen") continue;
    if (normalize(row.date) !== normalize(snap.todayDDMMYYYY)) {
      reopenRowsHaveCurrentDate = false;
      reasons.push(
        `Reopen JR "${row.jobRequisitionId}" Date must be "${snap.todayDDMMYYYY}" (found "${row.date || "(empty)"}").`
      );
    }
    if (!isProcessingDateDDMMYYYY(row.date)) {
      reopenRowsHaveCurrentDate = false;
      reasons.push(
        `Reopen JR "${row.jobRequisitionId}" Date must be DD-MM-YYYY.`
      );
    }
  }

  let closedRowsRemainInMaster = true;
  if (counts.Closed !== counts.closedRowsPresent) {
    closedRowsRemainInMaster = false;
    reasons.push("Closed row presence count mismatch.");
  }
  if (snap.expectedClosedIds) {
    for (const id of snap.expectedClosedIds) {
      const jid = normalize(id);
      const row = snap.masterRows.find(
        (r) => normalize(r.jobRequisitionId) === jid
      );
      if (!row) {
        closedRowsRemainInMaster = false;
        reasons.push(
          `Closed JR "${jid}" is missing from Master Sheet (rows must remain).`
        );
      } else if (normalize(row.status) !== "Closed") {
        closedRowsRemainInMaster = false;
        reasons.push(
          `Closed JR "${jid}" remains but Column K is "${normalize(row.status)}" (expected Closed).`
        );
      }
    }
  }

  const checks: FinalMasterSaveChecks = {
    newSheetUpdated,
    newSheetHeadersUnchanged,
    newSheetDatePopulated,
    jrMappingSuccessful,
    masterSheetUpdated,
    columnKValidStatusesOnly,
    newRowsCorrectlyMapped,
    reopenRowsHaveCurrentDate,
    closedRowsRemainInMaster,
    noDuplicateJrIds,
    workbookIsXlsm,
    vbaProjectPreservedHint,
  };

  const ok = Object.values(checks).every(Boolean) && reasons.length === 0;

  return {
    ok,
    reasons,
    checks,
    counts,
    fileName: snap.fileName,
  };
}

/** Reject any attempt to save as xlsx / strip macros via rename. */
export function assertFinalSaveIsXlsm(fileName: string): {
  ok: boolean;
  error?: string;
} {
  const name = fileName.trim() || FINAL_MASTER_WORKBOOK_NAME;
  if (!isXlsmMasterFilename(name)) {
    return {
      ok: false,
      error: `Final save refused: "${name}" is not XLSM. Master Workbook must remain "${FINAL_MASTER_WORKBOOK_NAME}" (VBA project preserved).`,
    };
  }
  if (/\.xlsx$/i.test(name)) {
    return {
      ok: false,
      error: `Final save refused: converting to XLSX is not allowed.`,
    };
  }
  return { ok: true };
}

export const XLSM_MIME =
  "application/vnd.ms-excel.sheet.macroEnabled.12";

/** Build expected Closed / New JR lists from a reconcile report. */
export function expectedIdsFromReconciliationReport(report: {
  details?: Array<{
    jobRequisitionId: string;
    newStatus: string;
    action: string;
  }>;
}): { expectedClosedIds: string[]; expectedNewIds: string[] } {
  const expectedClosedIds: string[] = [];
  const expectedNewIds: string[] = [];
  for (const d of report.details ?? []) {
    if (d.newStatus === "Closed" || d.action === "Closed") {
      expectedClosedIds.push(d.jobRequisitionId);
    }
    if (d.newStatus === "New" || d.action === "Added") {
      expectedNewIds.push(d.jobRequisitionId);
    }
  }
  return { expectedClosedIds, expectedNewIds };
}
