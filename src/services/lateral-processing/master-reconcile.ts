/**
 * master-reconcile.ts
 *
 * Final Lateral Job Status reconciliation — runs AFTER New Sheet refresh + JR comparison.
 *
 * Job Status is ALWAYS written to Master Sheet Column K only.
 * Allowed values: Active | Closed | Reopen | New
 *
 * Rules (keyed by Job Requisition ID):
 *   ACTIVE:  in New + Master, existing status NOT Closed → Column K = Active
 *   REOPEN:  in New + Master, existing status = Closed → Column K = Reopen,
 *            Date column for THAT row only = today (DD-MM-YYYY). No duplicate row.
 *            Active / Closed-absent / unrelated rows keep their existing dates.
 *   CLOSED:  in Master, not in New → Column K = Closed (keep row; date unchanged)
 *   NEW:     in New, not in Master → append row (header-name mapping), Column K = New
 *
 * Complete validation runs before success: every Master JR presence/status/action,
 * status + action counts, Reopen dates, per-status Column K, and statuses only in Column K.
 *
 * Never writes status into New Sheet.
 */

import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import type { LateralDataProcessingSetup } from "@/types/lateral-processing-setup";
import { parseDriveFolderIdFromUrl } from "@/services/drive/folder";
import {
  deleteEncryptedJson,
  readEncryptedJson,
  writeEncryptedJson,
} from "@/services/dataset/encrypted-json-store";
import {
  finalizeReconciledWorkbookWithoutConflictingStatusVba,
  type MacroExecutionResult,
} from "@/services/lateral-processing/run-vba-macro";
import { formatProcessingDateDDMMYYYY } from "@/services/lateral-processing/lateral-new-sheet-refresh";
import {
  JOB_REQUISITION_ID_HEADER,
  MASTER_DATE_HEADER,
  MASTER_JOB_STATUS_COLUMN_K,
  MASTER_JOB_STATUS_HEADER,
} from "@/services/lateral-processing/lateral-job-status-rules";
import {
  XLSM_MIME,
  assertFinalSaveIsXlsm,
  expectedIdsFromReconciliationReport,
  validateFinalMasterWorkbookSave,
  type FinalMasterSaveValidationResult,
} from "@/services/lateral-processing/lateral-final-master-save";
import { inspectLocalMasterWorkbookForFinalSave } from "@/services/lateral-processing/lateral-final-master-save-inspect";
import {
  DEFAULT_LATERAL_MASTER_SHEET,
  DEFAULT_LATERAL_NEW_SHEET,
} from "@/types/lateral-processing-setup";
import { readLateralDataProcessingSetup } from "@/services/lateral-processing/setup-store";

const execFileAsync = promisify(execFile);

const STAGING_META_FILE = "lateral-reconcile-staging.enc.json";
const STAGING_DIR = path.join(process.cwd(), ".data", "lateral-reconcile-staging");

export type ReconcileAction = "Added" | "Reopened" | "Closed" | "Activated";

export interface ReconciliationDetailRow {
  jobRequisitionId: string;
  previousStatus: string;
  newStatus: string;
  previousDate: string;
  newDate: string;
  action: ReconcileAction;
}

export interface ReconciliationSummary {
  newRequisitions: number;
  reopenedRequisitions: number;
  closedRequisitions: number;
  /** Count of Master rows set to Active (Rule 1) */
  activeUnchanged: number;
  totalNewSheetRequisitions: number;
  /** Final Column K status counts after reconciliation */
  statusCounts?: {
    Active: number;
    Closed: number;
    Reopen: number;
    New: number;
  };
  /** Action tallies (same as status buckets for final state) */
  actionCounts?: {
    newRowsAdded: number;
    reopenedRows: number;
    rowsClosed: number;
    rowsRemainingActive: number;
  };
}

export interface ReconciliationReport {
  summary: ReconciliationSummary;
  details: ReconciliationDetailRow[];
  generatedAt: string;
  today: string;
  /** Complete post-reconcile validation (present only when passed) */
  validation?: {
    ok: boolean;
    statusCounts: {
      Active: number;
      Closed: number;
      Reopen: number;
      New: number;
    };
    actionCounts: {
      newRowsAdded: number;
      reopenedRows: number;
      rowsClosed: number;
      rowsRemainingActive: number;
    };
    jrResults?: Array<{
      jobRequisitionId: string;
      presentInNewSheet: boolean;
      presentInMasterSheet: boolean;
      previousStatus: string;
      finalStatus: string;
      expectedStatus: string | null;
      expectedAction: string | null;
      ok: boolean;
    }>;
  };
}

export interface ReconciliationStagingMeta {
  stagingId: string;
  stagedFilePath: string;
  originalLocalPath: string;
  masterFileId: string;
  masterFileName: string;
  backupFileId: string | null;
  backupFileName: string | null;
  report: ReconciliationReport;
  createdAt: string;
}

export interface ReconciliationStageSuccess {
  ok: true;
  phase: "reconciliation_pending";
  stagingId: string;
  report: ReconciliationReport;
  masterFileId: string;
  masterFileName: string;
  backupFileId: string | null;
  backupFileName: string | null;
  pendingSave: true;
}

export interface ReconciliationFailure {
  ok: false;
  phase: "reconciliation";
  error: string;
  rolledBack: boolean;
}

export type ReconciliationStageResult =
  | ReconciliationStageSuccess
  | ReconciliationFailure;

function resolveFolderId(folderUrl: string, folderId: string): string {
  if (folderId.trim()) return folderId.trim();
  if (folderUrl.trim()) {
    const parsed = parseDriveFolderIdFromUrl(folderUrl.trim());
    if (parsed) return parsed;
  }
  return "";
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}`
  );
}

function currentDateString(): string {
  return formatProcessingDateDDMMYYYY();
}

/** Display date like 11-Aug-2026 */
export function formatReportDate(isoOrPlain: string): string {
  if (!isoOrPlain || isoOrPlain === "—") return "—";
  const raw = isoOrPlain.trim();
  // Already formatted
  if (/^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(raw)) return raw;
  // YYYY-MM-DD
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const day = Number(m[3]);
    const month = months[Number(m[2]) - 1] ?? m[2];
    return `${day}-${month}-${m[1]}`;
  }
  // Excel serial or Date parse
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    return `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
  }
  return raw;
}

async function downloadToTemp(
  fileId: string,
  nameHint: string
): Promise<string> {
  const { drive } = await getAuthorizedGmailClient();
  const ext = path.extname(nameHint) || ".xlsm";
  const base = path
    .basename(nameHint || fileId, ext)
    .replace(/[^\w.-]+/g, "_");
  const finalPath = path.join(
    os.tmpdir(),
    `lateral-reconcile-${Date.now()}-${base}${ext}`
  );

  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(finalPath, Buffer.from(response.data as ArrayBuffer));
  return finalPath;
}

async function uploadBackup(
  localPath: string,
  fileName: string,
  folderId: string,
  masterFileName?: string | null
): Promise<{ fileId: string; fileName: string }> {
  const {
    assertSafeMasterBackupFilename,
  } = await import(
    "@/services/lateral-processing/lateral-master-inplace-policy"
  );
  const backupGate = assertSafeMasterBackupFilename(fileName, masterFileName);
  if (!backupGate.ok) {
    throw new Error(backupGate.error);
  }

  const { drive } = await getAuthorizedGmailClient();
  const ext = path.extname(fileName).toLowerCase();
  const mimeType =
    ext === ".xlsm"
      ? "application/vnd.ms-excel.sheet.macroEnabled.12"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  // Backup only — never the Master identity. Master is always files.update in place.
  const created = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId], mimeType },
    media: { mimeType, body: createReadStream(localPath) },
    fields: "id,name",
    supportsAllDrives: true,
  });
  if (!created.data.id) throw new Error("Backup upload did not return a file ID.");
  const createdName = created.data.name ?? fileName;
  if (createdName.toLowerCase() === (masterFileName || "").trim().toLowerCase()) {
    throw new Error(
      `Backup upload unexpectedly used Master identity name "${createdName}". Aborting.`
    );
  }
  return { fileId: created.data.id, fileName: createdName };
}

async function updateDriveFile(
  fileId: string,
  localPath: string,
  fileName: string
): Promise<void> {
  const xlsmGate = assertFinalSaveIsXlsm(fileName);
  if (!xlsmGate.ok) {
    throw new Error(xlsmGate.error || "Final save must be XLSM.");
  }

  const {
    isForbiddenMasterIdentityFilename,
    resolveExpectedMasterFileName,
    validateMasterInPlaceIdentity,
  } = await import(
    "@/services/lateral-processing/lateral-master-inplace-policy"
  );
  const expectedFileName = resolveExpectedMasterFileName(fileName);
  if (isForbiddenMasterIdentityFilename(expectedFileName)) {
    throw new Error(
      `Refusing Master identity filename "${expectedFileName}" — never overwrite Master via a duplicate/backup name.`
    );
  }

  const { drive } = await getAuthorizedGmailClient();
  const mimeType = XLSM_MIME;

  // Always in-place update of the configured Master File ID — never files.create.
  await drive.files.update({
    fileId,
    requestBody: { name: expectedFileName, mimeType },
    media: { mimeType, body: createReadStream(localPath) },
    fields: "id,name,modifiedTime,mimeType",
    supportsAllDrives: true,
  });

  const after = await drive.files.get({
    fileId,
    fields: "id,name",
    supportsAllDrives: true,
  });
  const identity = validateMasterInPlaceIdentity({
    expectedFileId: fileId,
    actualFileId: after.data.id,
    expectedFileName,
    actualFileName: after.data.name,
  });
  if (!identity.ok) {
    throw new Error(identity.error);
  }
}

async function verifyDriveFileIsXlsm(
  fileId: string,
  expectedFileName: string
): Promise<{ ok: true; name: string; mimeType: string } | { ok: false; error: string }> {
  const { drive } = await getAuthorizedGmailClient();
  const meta = await drive.files.get({
    fileId,
    fields: "id,name,mimeType",
    supportsAllDrives: true,
  });
  const name = meta.data.name || "";
  const mimeType = meta.data.mimeType || "";

  const {
    resolveExpectedMasterFileName,
    validateMasterInPlaceIdentity,
  } = await import(
    "@/services/lateral-processing/lateral-master-inplace-policy"
  );
  const expected = resolveExpectedMasterFileName(expectedFileName);
  const identity = validateMasterInPlaceIdentity({
    expectedFileId: fileId,
    actualFileId: meta.data.id,
    expectedFileName: expected,
    actualFileName: name,
  });
  if (!identity.ok) {
    return { ok: false, error: identity.error };
  }
  if (!assertFinalSaveIsXlsm(name).ok) {
    return {
      ok: false,
      error: `Drive file after save is not XLSM (name="${name}"). VBA project must be preserved.`,
    };
  }
  if (
    mimeType &&
    mimeType !== XLSM_MIME &&
    !/macroenabled|ms-excel\.sheet\.macro/i.test(mimeType)
  ) {
    return {
      ok: false,
      error: `Drive file mimeType after save is "${mimeType}" (expected XLSM macro-enabled).`,
    };
  }
  return { ok: true, name, mimeType: mimeType || XLSM_MIME };
}

function buildPythonScript(): string {
  // Column K = 11. Job Status is ALWAYS written there on Master Sheet only.
  return `
import json, sys, re
from openpyxl import load_workbook
from datetime import datetime, date

path = sys.argv[1]
out_path = sys.argv[2]
master_sheet_name = sys.argv[3]
new_sheet_name = sys.argv[4]
today = sys.argv[5]  # DD-MM-YYYY processing date

JOB_ID = ${JSON.stringify(JOB_REQUISITION_ID_HEADER)}
STATUS = ${JSON.stringify(MASTER_JOB_STATUS_HEADER)}
DATE = ${JSON.stringify(MASTER_DATE_HEADER)}
STATUS_COL_K = ${MASTER_JOB_STATUS_COLUMN_K}  # Column K — ALWAYS
# Column L (12) is an Oorwin/filter column — may contain Active/Closed text; ignore for leakage.
STATUS_LEAK_IGNORE_COLS = {12}

ALLOWED = {"Active", "Closed", "Reopen", "New"}

def norm(v):
    if v is None:
        return ""
    return str(v).strip()

def fmt_date(v):
    if v is None or v == "":
        return ""
    if isinstance(v, datetime):
        return v.strftime("%d-%m-%Y")
    if isinstance(v, date):
        return v.strftime("%d-%m-%Y")
    return str(v).strip()

def header_map(ws):
    headers = {}
    for col in range(1, (ws.max_column or 1) + 1):
        h = norm(ws.cell(1, col).value)
        if h:
            headers[h] = col
    return headers

wb = load_workbook(path, keep_vba=True, data_only=False)

if master_sheet_name not in wb.sheetnames:
    print(json.dumps({"ok": False, "error": f'Master worksheet "{master_sheet_name}" not found. Available: {", ".join(wb.sheetnames)}'}))
    sys.exit(0)
if new_sheet_name not in wb.sheetnames:
    print(json.dumps({"ok": False, "error": f'New Sheet worksheet "{new_sheet_name}" not found. Available: {", ".join(wb.sheetnames)}'}))
    sys.exit(0)

ws_master = wb[master_sheet_name]
ws_new = wb[new_sheet_name]

mh = header_map(ws_master)
nh = header_map(ws_new)

for required, sheet_headers, label in [
    (JOB_ID, mh, "Master Sheet"),
    (JOB_ID, nh, "New Sheet"),
    (DATE, mh, "Master Sheet"),
]:
    if required not in sheet_headers:
        print(json.dumps({"ok": False, "error": f'"{required}" column not found in {label}.'}))
        sys.exit(0)

# Job Status MUST be Master Sheet Column K
k_header = norm(ws_master.cell(1, STATUS_COL_K).value)
if k_header != STATUS:
    print(json.dumps({
        "ok": False,
        "error": f'Master Sheet Column K must be "{STATUS}" (found "{k_header or "(empty)"}"). Job Status is ALWAYS Column K.'
    }))
    sys.exit(0)
if STATUS in mh and mh[STATUS] != STATUS_COL_K:
    print(json.dumps({
        "ok": False,
        "error": f'"{STATUS}" header is in column {mh[STATUS]}, but Job Status must be Column K ({STATUS_COL_K}).'
    }))
    sys.exit(0)

m_job_col = mh[JOB_ID]
m_status_col = STATUS_COL_K  # ALWAYS Column K — never write status to New Sheet
m_date_col = mh[DATE]
n_job_col = nh[JOB_ID]

def index_by_job_id(ws, job_col):
    by_id = {}
    for row in range(2, (ws.max_row or 1) + 1):
        jid = norm(ws.cell(row, job_col).value)
        if jid:
            # Duplicates already gated earlier; last wins only if gate skipped
            by_id[jid] = row
    return by_id

master_row_by_id = index_by_job_id(ws_master, m_job_col)
new_row_by_id = index_by_job_id(ws_new, n_job_col)

new_id_set = set(new_row_by_id.keys())
master_id_set = set(master_row_by_id.keys())

# Header-name mapping for NEW rows: Master headers drive column order (never by position).
# Skip Job Status — Column K is set explicitly to "New".
def build_new_to_master_maps():
    aliases = {
        "Primary Location/Office Locate": ["Primary Location/Office Locate", "Primary Location"],
        "Primary Location": ["Primary Location", "Primary Location/Office Locate"],
    }
    new_by_name = {h: c for h, c in nh.items()}
    mappings = []  # (master_col, master_header, new_col|None)
    max_mcol = max([STATUS_COL_K] + list(mh.values()) + [1])
    for mcol in range(1, max_mcol + 1):
        mheader = norm(ws_master.cell(1, mcol).value)
        if not mheader:
            continue
        if mcol == STATUS_COL_K or mheader == STATUS:
            mappings.append((mcol, mheader or STATUS, None))
            continue
        candidates = aliases.get(mheader, [mheader])
        new_col = None
        for cand in candidates:
            if cand in new_by_name:
                new_col = new_by_name[cand]
                break
            for nh_name, nh_col in new_by_name.items():
                if nh_name.lower() == cand.lower():
                    new_col = nh_col
                    break
            if new_col is not None:
                break
        mappings.append((mcol, mheader, new_col))
    return mappings

new_to_master_maps = build_new_to_master_maps()

details = []
counts = {"new": 0, "reopen": 0, "closed": 0, "active": 0}
new_insert_meta = []  # validation payload
reopen_meta = []  # Closed → Reopen date updates
active_rows = []
closed_rows = []

def write_status(row, status):
    if status not in ALLOWED:
        raise ValueError(f"Invalid Job Status: {status}")
    ws_master.cell(row, m_status_col).value = status  # Column K only

def snapshot_master_rows():
    snap = {}
    max_c = max([STATUS_COL_K] + list(mh.values()) + [1])
    for r in range(2, (ws_master.max_row or 1) + 1):
        jid = norm(ws_master.cell(r, m_job_col).value)
        if not jid:
            continue
        cells = {}
        for c in range(1, max_c + 1):
            v = ws_master.cell(r, c).value
            cells[str(c)] = "" if v is None else str(v)
        snap[str(r)] = cells
    return snap

def snapshot_dates():
    """Date values before Active/Reopen/Closed — used to prove only Reopen changes Date."""
    snap = {}
    for r in range(2, (ws_master.max_row or 1) + 1):
        jid = norm(ws_master.cell(r, m_job_col).value)
        if not jid:
            continue
        snap[str(r)] = fmt_date(ws_master.cell(r, m_date_col).value)
    return snap

# Snapshots BEFORE status rules (previous status + dates for complete validation).
dates_before_status = snapshot_dates()
previous_status_by_id = {}
for jid, row in master_row_by_id.items():
    previous_status_by_id[jid] = norm(ws_master.cell(row, m_status_col).value)
master_ids_before = set(master_id_set)

# RULE 1 — ACTIVE / RULE 2 — REOPEN (in both). Never create a duplicate row.
for jid in sorted(new_id_set & master_id_set):
    row = master_row_by_id[jid]
    prev_status = norm(ws_master.cell(row, m_status_col).value) or "—"
    prev_date = fmt_date(ws_master.cell(row, m_date_col).value) or "—"

    if prev_status == "Closed":
        # RULE 2 — REOPEN: Column K = Reopen; Date for THIS row only = today (DD-MM-YYYY).
        write_status(row, "Reopen")
        ws_master.cell(row, m_date_col).value = today  # DD-MM-YYYY string
        counts["reopen"] += 1
        reopen_meta.append({
            "jobRequisitionId": jid,
            "masterRowNumber": row,
            "previousStatus": prev_status,
            "previousDate": prev_date,
            "newStatus": "Reopen",
            "newDate": today,
        })
        details.append({
            "jobRequisitionId": jid,
            "previousStatus": prev_status,
            "newStatus": "Reopen",
            "previousDate": prev_date,
            "newDate": today,
            "action": "Reopened",
        })
    else:
        # RULE 1 — ACTIVE: status only. Do NOT update Date merely because processed.
        write_status(row, "Active")
        # Date column intentionally untouched.
        active_rows.append(row)
        counts["active"] += 1
        details.append({
            "jobRequisitionId": jid,
            "previousStatus": prev_status if prev_status != "—" else "Not Found",
            "newStatus": "Active",
            "previousDate": prev_date,
            "newDate": prev_date,
            "action": "Activated",
        })

# RULE 3 — CLOSED (in Master, not in New). Keep row; do NOT update Date.
for jid in sorted(master_id_set - new_id_set):
    row = master_row_by_id[jid]
    prev_status = norm(ws_master.cell(row, m_status_col).value) or "—"
    prev_date = fmt_date(ws_master.cell(row, m_date_col).value) or "—"
    write_status(row, "Closed")
    # Date column intentionally untouched for Closed-absent rows.
    closed_rows.append(row)
    counts["closed"] += 1
    details.append({
        "jobRequisitionId": jid,
        "previousStatus": prev_status,
        "newStatus": "Closed",
        "previousDate": prev_date,
        "newDate": prev_date,
        "action": "Closed",
    })

# ── Validate Reopen date updates (only reopened JR gets today's date) ───────
def validate_reopen_dates():
    reasons = []
    # DD-MM-YYYY format for processing date
    if not re.match(r"^[0-9]{2}-[0-9]{2}-[0-9]{4}$", today):
        reasons.append(f'Processing date must be DD-MM-YYYY (got "{today}").')

    reopened_rows = set()
    for meta in reopen_meta:
        row = meta["masterRowNumber"]
        reopened_rows.add(row)
        status = norm(ws_master.cell(row, STATUS_COL_K).value)
        if status != "Reopen":
            reasons.append(
                f'Master Sheet Column K for reopened JR "{meta["jobRequisitionId"]}" '
                f'(row {row}) must be "Reopen" (found "{status or "(empty)"}").'
            )
        date_val = fmt_date(ws_master.cell(row, m_date_col).value)
        if date_val != today:
            reasons.append(
                f'Reopened JR "{meta["jobRequisitionId"]}" Date must be "{today}" '
                f'(found "{date_val or "(empty)"}").'
            )
        if not re.match(r"^[0-9]{2}-[0-9]{2}-[0-9]{4}$", date_val or ""):
            reasons.append(
                f'Reopened JR "{meta["jobRequisitionId"]}" Date must be DD-MM-YYYY '
                f'(found "{date_val or "(empty)"}").'
            )

    # Active rows: Date must be unchanged
    for row in active_rows:
        before = dates_before_status.get(str(row), "")
        after = fmt_date(ws_master.cell(row, m_date_col).value)
        if before != after:
            reasons.append(
                f'Active Master row {row} Date was modified (before "{before}", after "{after}"). '
                f'Active rows must keep their date.'
            )

    # Closed-absent rows: Date must be unchanged
    for row in closed_rows:
        before = dates_before_status.get(str(row), "")
        after = fmt_date(ws_master.cell(row, m_date_col).value)
        if before != after:
            reasons.append(
                f'Closed (absent from New Sheet) Master row {row} Date was modified '
                f'(before "{before}", after "{after}").'
            )

    # Unrelated / non-reopened rows: Date must be unchanged
    for r_str, before in dates_before_status.items():
        r = int(r_str)
        if r in reopened_rows:
            continue
        after = fmt_date(ws_master.cell(r, m_date_col).value)
        if before != after:
            reasons.append(
                f'Unrelated Master row {r} Date changed during reopen processing '
                f'(before "{before}", after "{after}").'
            )

    return reasons

reopen_validation_reasons = validate_reopen_dates()
if reopen_validation_reasons:
    print(json.dumps({
        "ok": False,
        "error": "Reopen date update validation failed. " + " ".join(reopen_validation_reasons),
        "validationReasons": reopen_validation_reasons,
    }))
    sys.exit(0)

# ── RULE 4 — NEW row insertion (append only, header-name mapping) ───────────
existing_before_new = snapshot_master_rows()
ids_to_insert = sorted(new_id_set - master_id_set)

for jid in ids_to_insert:
    src_row = new_row_by_id[jid]
    # Never overwrite existing Master rows — append after last used JR row.
    last_used = 1
    for r in range(2, (ws_master.max_row or 1) + 1):
        if norm(ws_master.cell(r, m_job_col).value):
            last_used = r
    paste_row = last_used + 1

    # Guard: paste_row must not already contain a JR
    if norm(ws_master.cell(paste_row, m_job_col).value):
        print(json.dumps({
            "ok": False,
            "error": f'Cannot append NEW JR "{jid}" — Master row {paste_row} is already occupied.'
        }))
        sys.exit(0)

    stored_jr = ws_new.cell(src_row, n_job_col).value
    field_copies = []

    for mcol, mheader, ncol in new_to_master_maps:
        if mcol == STATUS_COL_K or mheader == STATUS:
            continue  # Column K set explicitly below
        if ncol is None:
            # Master-only field — leave blank on new row (do not invent / position-copy)
            continue
        src_val = ws_new.cell(src_row, ncol).value
        if mheader == DATE and src_val in (None, ""):
            src_val = today
        ws_master.cell(paste_row, mcol).value = src_val
        field_copies.append({
            "masterHeader": mheader,
            "masterCol": mcol,
            "newSheetCol": ncol,
        })

    # Ensure JR ID is present even if header alias missed
    ws_master.cell(paste_row, m_job_col).value = stored_jr
    write_status(paste_row, "New")  # Column K = New explicitly

    counts["new"] += 1
    new_insert_meta.append({
        "jobRequisitionId": jid,
        "storedJobRequisitionId": "" if stored_jr is None else str(stored_jr),
        "newSheetRowNumber": src_row,
        "masterAppendRowNumber": paste_row,
        "fieldCopies": field_copies,
    })
    details.append({
        "jobRequisitionId": jid,
        "previousStatus": "Not Found",
        "newStatus": "New",
        "previousDate": "—",
        "newDate": today,
        "action": "Added",
    })

# ── Validate NEW inserts ────────────────────────────────────────────────────
def validate_new_inserts():
    reasons = []
    # Rebuild JR index after inserts
    after_by_id = {}
    for r in range(2, (ws_master.max_row or 1) + 1):
        jid = norm(ws_master.cell(r, m_job_col).value)
        if not jid:
            continue
        after_by_id.setdefault(jid, []).append(r)

    max_c = max([STATUS_COL_K] + list(mh.values()) + [1])

    # Existing rows untouched by NEW insertion
    for r_str, before_cells in existing_before_new.items():
        r = int(r_str)
        for c_str, before_val in before_cells.items():
            c = int(c_str)
            after_v = ws_master.cell(r, c).value
            after_s = "" if after_v is None else str(after_v)
            if after_s.strip() != str(before_val).strip():
                reasons.append(
                    f'Existing Master row {r} col {c} was modified during NEW insert.'
                )
                break

    for meta in new_insert_meta:
        jid = meta["jobRequisitionId"]
        rows = after_by_id.get(jid, [])
        if len(rows) == 0:
            reasons.append(f'JR ID "{jid}" was not inserted into Master Sheet.')
            continue
        if len(rows) > 1:
            reasons.append(
                f'Duplicate JR ID "{jid}" after insert (rows {", ".join(str(x) for x in rows)}).'
            )
        row = rows[0]
        if row != meta["masterAppendRowNumber"]:
            reasons.append(
                f'JR "{jid}" landed on row {row}, expected append row {meta["masterAppendRowNumber"]}.'
            )
        status = norm(ws_master.cell(row, STATUS_COL_K).value)
        if status != "New":
            reasons.append(
                f'Master Sheet Column K for JR "{jid}" (row {row}) must be "New" (found "{status or "(empty)"}").'
            )
        # Correct columns populated from New Sheet (by header name, not position)
        src_row = meta["newSheetRowNumber"]
        for fc in meta["fieldCopies"]:
            expected = ws_new.cell(src_row, fc["newSheetCol"]).value
            # Date empty in New Sheet → processing date (business rule)
            if fc["masterHeader"] == DATE and expected in (None, ""):
                expected = today
            actual = ws_master.cell(row, fc["masterCol"]).value
            exp_s = "" if expected is None else str(expected).strip()
            act_s = "" if actual is None else str(actual).strip()
            if exp_s != act_s:
                reasons.append(
                    f'JR "{jid}" column "{fc["masterHeader"]}" mismatch: expected "{exp_s}", got "{act_s}".'
                )
        # JR ID present
        jr_cell = norm(ws_master.cell(row, m_job_col).value)
        if jr_cell != jid:
            reasons.append(f'JR ID not correctly stored on Master row {row} for "{jid}".')

    return reasons

if ids_to_insert:
    validation_reasons = validate_new_inserts()
    if validation_reasons:
        print(json.dumps({
            "ok": False,
            "error": "NEW row insertion validation failed. " + " ".join(validation_reasons),
            "validationReasons": validation_reasons,
        }))
        sys.exit(0)

# ── Complete status reconciliation validation (must pass before success) ────
def validate_complete_status_reconciliation():
    reasons = []
    jr_results = []
    status_counts = {"Active": 0, "Closed": 0, "Reopen": 0, "New": 0}
    action_by_id = {}
    for d in details:
        action_by_id[d["jobRequisitionId"]] = d.get("action", "")

    # Index Master after all mutations
    after_rows = []
    cells_by_row = {}
    headers_by_col = {}
    max_c = max([STATUS_COL_K] + list(mh.values()) + [(ws_master.max_column or 1)])
    for c in range(1, max_c + 1):
        headers_by_col[str(c)] = norm(ws_master.cell(1, c).value)

    for r in range(2, (ws_master.max_row or 1) + 1):
        jid = norm(ws_master.cell(r, m_job_col).value)
        if not jid:
            continue
        final_status = norm(ws_master.cell(r, STATUS_COL_K).value)
        final_date = fmt_date(ws_master.cell(r, m_date_col).value)
        in_new = jid in new_id_set
        in_master_before = jid in master_ids_before
        prev = previous_status_by_id.get(jid, "")
        reported_action = action_by_id.get(jid, "")

        # Expected status from rules
        if in_new and not in_master_before:
            expected_status, expected_action = "New", "Added"
        elif (not in_new) and in_master_before:
            expected_status, expected_action = "Closed", "Closed"
        elif in_new and in_master_before:
            if prev == "Closed":
                expected_status, expected_action = "Reopen", "Reopened"
            else:
                expected_status, expected_action = "Active", "Activated"
        else:
            expected_status, expected_action = None, None

        row_reasons = []
        if expected_status is None:
            row_reasons.append(
                f'JR "{jid}" could not resolve an expected status.'
            )
        elif final_status != expected_status:
            row_reasons.append(
                f'JR "{jid}" final status "{final_status or "(empty)"}" does not match expected "{expected_status}" '
                f'(inNew={in_new}, inMasterBefore={in_master_before}, previous="{prev or "Not Found"}").'
            )

        if expected_action and reported_action != expected_action:
            row_reasons.append(
                f'JR "{jid}" action "{reported_action or "(missing)"}" does not match expected "{expected_action}".'
            )

        # Per-status Column K checks
        if expected_status == "Active" and final_status != "Active":
            row_reasons.append(f'Active JR "{jid}" Column K must be "Active".')
        if expected_status == "Closed" and final_status != "Closed":
            row_reasons.append(f'Closed JR "{jid}" Column K must be "Closed".')
        if expected_status == "Reopen" and final_status != "Reopen":
            row_reasons.append(f'Reopen JR "{jid}" Column K must be "Reopen".')
        if expected_status == "New" and final_status != "New":
            row_reasons.append(f'New JR "{jid}" Column K must be "New".')

        if final_status not in ALLOWED:
            row_reasons.append(
                f'JR "{jid}" Column K has invalid status "{final_status or "(empty)"}".'
            )
        else:
            status_counts[final_status] += 1

        # Reopen date = current date
        if final_status == "Reopen" or expected_status == "Reopen":
            if final_date != today:
                row_reasons.append(
                    f'Reopened JR "{jid}" Date must be "{today}" (found "{final_date or "(empty)"}").'
                )
            if not re.match(r"^[0-9]{2}-[0-9]{2}-[0-9]{4}$", final_date or ""):
                row_reasons.append(
                    f'Reopened JR "{jid}" Date must be DD-MM-YYYY (found "{final_date or "(empty)"}").'
                )

        jr_results.append({
            "jobRequisitionId": jid,
            "masterRowNumber": r,
            "presentInNewSheet": in_new,
            "presentInMasterSheet": True,
            "previousStatus": prev or "Not Found",
            "finalStatus": final_status,
            "expectedStatus": expected_status,
            "expectedAction": expected_action,
            "reportedAction": reported_action,
            "actionCorrect": bool(expected_action) and reported_action == expected_action,
            "ok": len(row_reasons) == 0,
            "reasons": row_reasons,
        })
        reasons.extend(row_reasons)

        # Cell scan for status leakage
        row_cells = {}
        for c in range(1, max_c + 1):
            v = ws_master.cell(r, c).value
            row_cells[str(c)] = "" if v is None else str(v)
        cells_by_row[str(r)] = row_cells

    # Status leakage: Active|Closed|Reopen|New ONLY in Column K
    # (ignore Column L / filter columns — not Job Status)
    for r_str, cells in cells_by_row.items():
        r = int(r_str)
        jid = norm(ws_master.cell(r, m_job_col).value)
        for c_str, raw in cells.items():
            c = int(c_str)
            if c == STATUS_COL_K or c in STATUS_LEAK_IGNORE_COLS:
                continue
            val = norm(raw)
            if val in ALLOWED:
                header = headers_by_col.get(c_str) or f"Column {c}"
                msg = (
                    f'Status value "{val}" found outside Column K at Master row {r} '
                    f'({header}'
                    + (f', JR "{jid}"' if jid else "")
                    + "). Statuses Active|Closed|Reopen|New must exist ONLY in Master Sheet Column K."
                )
                reasons.append(msg)

    counted = status_counts["Active"] + status_counts["Closed"] + status_counts["Reopen"] + status_counts["New"]
    if counted != len(jr_results):
        reasons.append(
            f'Status counts ({counted}) do not match Master JR row count ({len(jr_results)}).'
        )

    action_counts = {
        "newRowsAdded": status_counts["New"],
        "reopenedRows": status_counts["Reopen"],
        "rowsClosed": status_counts["Closed"],
        "rowsRemainingActive": status_counts["Active"],
    }

    return {
        "ok": len(reasons) == 0,
        "reasons": reasons,
        "jrResults": jr_results,
        "statusCounts": status_counts,
        "actionCounts": action_counts,
    }

complete_validation = validate_complete_status_reconciliation()
if not complete_validation["ok"]:
    print(json.dumps({
        "ok": False,
        "error": "Complete status reconciliation validation failed. " + " ".join(complete_validation["reasons"]),
        "validationReasons": complete_validation["reasons"],
        "validation": complete_validation,
    }))
    sys.exit(0)

wb.save(out_path)
wb.close()

summary = {
    "newRequisitions": counts["new"],
    "reopenedRequisitions": counts["reopen"],
    "closedRequisitions": counts["closed"],
    "activeUnchanged": counts["active"],
    "totalNewSheetRequisitions": len(new_id_set),
    "statusCounts": complete_validation["statusCounts"],
    "actionCounts": complete_validation["actionCounts"],
}

print(json.dumps({
    "ok": True,
    "summary": summary,
    "details": details,
    "statusColumn": "K",
    "newInserts": new_insert_meta,
    "reopenUpdates": reopen_meta,
    "validation": complete_validation,
}))
`.trim();
}

async function clearPreviousStaging(): Promise<void> {
  const prev = await readEncryptedJson<ReconciliationStagingMeta>(STAGING_META_FILE);
  if (prev) {
    await fs.unlink(prev.stagedFilePath).catch(() => undefined);
    await fs.unlink(prev.originalLocalPath).catch(() => undefined);
  }
  await deleteEncryptedJson(STAGING_META_FILE);
  // Clean staging dir leftovers
  try {
    const files = await fs.readdir(STAGING_DIR);
    await Promise.all(
      files.map((f) => fs.unlink(path.join(STAGING_DIR, f)).catch(() => undefined))
    );
  } catch {
    // dir may not exist
  }
}

export async function readReconciliationStaging(): Promise<ReconciliationStagingMeta | null> {
  const meta = await readEncryptedJson<ReconciliationStagingMeta>(STAGING_META_FILE);
  if (!meta) return null;
  if (!existsSync(meta.stagedFilePath)) {
    await deleteEncryptedJson(STAGING_META_FILE);
    return null;
  }
  return meta;
}

/**
 * Run reconciliation and stage the result. Does NOT save to Drive.
 */
export async function stageMasterReconciliation(
  setup: LateralDataProcessingSetup,
  options?: { localWorkbookPath?: string }
): Promise<ReconciliationStageResult> {
  const masterSheetName = setup.masterSheet || "Master Sheet";
  const newSheetName = setup.masterNewSheet || "New Sheet";
  const today = currentDateString();

  let localPath: string | null = null;

  try {
    await clearPreviousStaging();
    await fs.mkdir(STAGING_DIR, { recursive: true });

    if (options?.localWorkbookPath) {
      if (!existsSync(options.localWorkbookPath)) {
        return {
          ok: false,
          phase: "reconciliation",
          error:
            "Staged New Sheet workbook was not found. Production Master was not downloaded or modified.",
          rolledBack: false,
        };
      }
      const extFromLocal =
        path.extname(options.localWorkbookPath) ||
        path.extname(setup.masterWorkbook.fileName) ||
        ".xlsm";
      localPath = path.join(
        os.tmpdir(),
        `lateral-reconcile-from-staged-${Date.now()}${extFromLocal}`
      );
      await fs.copyFile(options.localWorkbookPath, localPath);
    } else {
      localPath = await downloadToTemp(
        setup.masterWorkbook.fileId,
        setup.masterWorkbook.fileName
      );
    }

    // JR comparison gate (ID-only). Detect duplicates BEFORE any status changes.
    const { compareJobRequisitionsFromLocalMaster } = await import(
      "@/services/lateral-processing/lateral-job-requisition-comparison"
    );
    const compareResult = await compareJobRequisitionsFromLocalMaster({
      localPath,
      masterSheetName,
      newSheetName,
    });
    if (!compareResult.ok) {
      await fs.unlink(localPath).catch(() => undefined);
      return {
        ok: false,
        phase: "reconciliation",
        error: compareResult.message,
        rolledBack: false,
      };
    }

    // Backup of current Master (pre-reconcile) on Drive for Cancel & Rollback
    let backupFileId: string | null = null;
    let backupFileName: string | null = null;
    const baseName = path.basename(
      setup.masterWorkbook.fileName,
      path.extname(setup.masterWorkbook.fileName)
    );
    const ext = path.extname(setup.masterWorkbook.fileName) || ".xlsm";
    const backupName = `${baseName}_RECONCILE_BACKUP_${timestamp()}${ext}`;

    const destFolder =
      resolveFolderId(
        setup.destinationFolder.folderUrl,
        setup.destinationFolder.folderId
      ) || "";

    try {
      const { drive } = await getAuthorizedGmailClient();
      let folderId = destFolder;
      if (!folderId) {
        const meta = await drive.files.get({
          fileId: setup.masterWorkbook.fileId,
          fields: "parents",
          supportsAllDrives: true,
        });
        folderId = meta.data.parents?.[0] ?? "";
      }
      if (folderId) {
        const backup = await uploadBackup(
          localPath,
          backupName,
          folderId,
          setup.masterWorkbook.fileName
        );
        backupFileId = backup.fileId;
        backupFileName = backup.fileName;
      }
    } catch (err) {
      await fs.unlink(localPath).catch(() => undefined);
      return {
        ok: false,
        phase: "reconciliation",
        error: `Failed to create reconciliation backup: ${err instanceof Error ? err.message : String(err)}`,
        rolledBack: false,
      };
    }

    const stagingId = randomUUID();
    const stagedFilePath = path.join(
      STAGING_DIR,
      `${stagingId}${ext}`
    );
    const originalCopyPath = path.join(
      STAGING_DIR,
      `${stagingId}_original${ext}`
    );

    // Keep a local original copy for rollback without re-downloading
    await fs.copyFile(localPath, originalCopyPath);

    const scriptPath = path.join(
      os.tmpdir(),
      `lateral-reconcile-${Date.now()}.py`
    );
    await fs.writeFile(scriptPath, buildPythonScript(), "utf8");

    let stdout = "";
    try {
      const result = await execFileAsync(
        "python",
        [
          scriptPath,
          localPath,
          stagedFilePath,
          masterSheetName,
          newSheetName,
          today,
        ],
        {
          windowsHide: true,
          timeout: 300_000,
          maxBuffer: 32 * 1024 * 1024,
        }
      );
      stdout = (result.stdout || "").trim();
    } finally {
      await fs.unlink(scriptPath).catch(() => undefined);
      await fs.unlink(localPath).catch(() => undefined);
      localPath = null;
    }

    const payload = JSON.parse(stdout || "{}") as {
      ok?: boolean;
      error?: string;
      summary?: ReconciliationSummary;
      details?: ReconciliationDetailRow[];
      validation?: ReconciliationReport["validation"] & { ok?: boolean; reasons?: string[] };
    };

    if (!payload.ok || !payload.summary || !payload.details) {
      await fs.unlink(stagedFilePath).catch(() => undefined);
      await fs.unlink(originalCopyPath).catch(() => undefined);
      return {
        ok: false,
        phase: "reconciliation",
        error: payload.error || "Reconciliation failed.",
        rolledBack: true,
      };
    }

    // Do not report success until complete status reconciliation validation passes.
    if (!payload.validation?.ok) {
      await fs.unlink(stagedFilePath).catch(() => undefined);
      await fs.unlink(originalCopyPath).catch(() => undefined);
      return {
        ok: false,
        phase: "reconciliation",
        error:
          payload.error ||
          (payload.validation?.reasons?.length
            ? `Complete status reconciliation validation failed. ${payload.validation.reasons.join(" ")}`
            : "Complete status reconciliation validation did not pass."),
        rolledBack: true,
      };
    }

    // Format dates for display
    const details = payload.details.map((row) => ({
      ...row,
      previousDate: formatReportDate(row.previousDate),
      newDate: formatReportDate(row.newDate),
    }));

    const report: ReconciliationReport = {
      summary: payload.summary,
      details,
      generatedAt: new Date().toISOString(),
      today: formatReportDate(today),
      validation: {
        ok: true,
        statusCounts: payload.validation.statusCounts,
        actionCounts: payload.validation.actionCounts,
        jrResults: payload.validation.jrResults?.map((r) => ({
          jobRequisitionId: r.jobRequisitionId,
          presentInNewSheet: r.presentInNewSheet,
          presentInMasterSheet: r.presentInMasterSheet,
          previousStatus: r.previousStatus,
          finalStatus: r.finalStatus,
          expectedStatus: r.expectedStatus,
          expectedAction: r.expectedAction,
          ok: r.ok,
        })),
      },
    };

    const meta: ReconciliationStagingMeta = {
      stagingId,
      stagedFilePath,
      originalLocalPath: originalCopyPath,
      masterFileId: setup.masterWorkbook.fileId,
      masterFileName: setup.masterWorkbook.fileName,
      backupFileId,
      backupFileName,
      report,
      createdAt: new Date().toISOString(),
    };
    await writeEncryptedJson(STAGING_META_FILE, meta);

    return {
      ok: true,
      phase: "reconciliation_pending",
      stagingId,
      report,
      masterFileId: setup.masterWorkbook.fileId,
      masterFileName: setup.masterWorkbook.fileName,
      backupFileId,
      backupFileName,
      pendingSave: true,
    };
  } catch (err) {
    if (localPath) await fs.unlink(localPath).catch(() => undefined);
    return {
      ok: false,
      phase: "reconciliation",
      error:
        err instanceof Error
          ? err.message
          : "Unexpected error during Master Sheet reconciliation.",
      rolledBack: true,
    };
  }
}

/** Confirm & Save — final XLSM Master save with pre-save validation + backup retention. */
export async function confirmReconciliationSave(): Promise<
  | {
      ok: true;
      masterFileId: string;
      masterFileName: string;
      report: ReconciliationReport;
      updatedAt: string;
      macro: MacroExecutionResult;
      finalSaveValidation: FinalMasterSaveValidationResult;
      backupFileId: string | null;
      backupFileName: string | null;
      finalSaveVerified: true;
    }
  | {
      ok: false;
      error: string;
      phase?: "save" | "macro" | "validation" | "backup";
      macro?: MacroExecutionResult;
      report?: ReconciliationReport;
      finalSaveValidation?: FinalMasterSaveValidationResult;
    }
> {
  const meta = await readReconciliationStaging();
  if (!meta) {
    return { ok: false, error: "No pending reconciliation to save." };
  }
  if (!existsSync(meta.stagedFilePath)) {
    await clearPreviousStaging();
    return { ok: false, error: "Staged reconciled file is missing. Re-run processing." };
  }

  const report = meta.report;
  const xlsmGate = assertFinalSaveIsXlsm(meta.masterFileName);
  if (!xlsmGate.ok) {
    return {
      ok: false,
      phase: "validation",
      error: xlsmGate.error || "Master Workbook must remain XLSM.",
      report,
    };
  }

  const setup = await readLateralDataProcessingSetup();
  const masterSheetName =
    setup?.masterSheet?.trim() || DEFAULT_LATERAL_MASTER_SHEET;
  const newSheetName =
    setup?.masterNewSheet?.trim() || DEFAULT_LATERAL_NEW_SHEET;
  const today = currentDateString();
  const { expectedClosedIds, expectedNewIds } =
    expectedIdsFromReconciliationReport(report);

  // ── Pre-save validation (must pass before any final Drive overwrite) ─────
  const inspected = await inspectLocalMasterWorkbookForFinalSave({
    localPath: meta.stagedFilePath,
    fileName: meta.masterFileName,
    masterSheetName,
    newSheetName,
    todayDDMMYYYY: today,
    expectedClosedIds,
    expectedNewIds,
  });
  if (!inspected.ok) {
    return {
      ok: false,
      phase: "validation",
      error: inspected.error,
      report,
    };
  }

  const finalSaveValidation = validateFinalMasterWorkbookSave(inspected.snapshot);
  if (!finalSaveValidation.ok) {
    return {
      ok: false,
      phase: "validation",
      error:
        "Final Master save validation failed. " +
        finalSaveValidation.reasons.join(" "),
      report,
      finalSaveValidation,
    };
  }

  // ── Retain / create backup before final save ─────────────────────────────
  let backupFileId = meta.backupFileId;
  let backupFileName = meta.backupFileName;
  if (!backupFileId) {
    try {
      const destFolder = setup
        ? resolveFolderId(
            setup.destinationFolder.folderUrl,
            setup.destinationFolder.folderId
          )
        : "";
      const ext = path.extname(meta.masterFileName) || ".xlsm";
      const baseName = path.basename(meta.masterFileName, ext);
      const backupName = `${baseName}_FINAL_SAVE_BACKUP_${timestamp()}${ext}`;
      const backupSource = existsSync(meta.originalLocalPath)
        ? meta.originalLocalPath
        : meta.stagedFilePath;

      const { drive } = await getAuthorizedGmailClient();
      let folderId = destFolder;
      if (!folderId) {
        const fileMeta = await drive.files.get({
          fileId: meta.masterFileId,
          fields: "parents",
          supportsAllDrives: true,
        });
        folderId = fileMeta.data.parents?.[0] ?? "";
      }
      if (folderId) {
        const backup = await uploadBackup(
          backupSource,
          backupName,
          folderId,
          meta.masterFileName
        );
        backupFileId = backup.fileId;
        backupFileName = backup.fileName;
      } else {
        backupFileId = `${meta.masterFileId}#pre-final-save`;
        backupFileName = `${baseName} (Drive parent unknown — retain remote revisions ${timestamp()})`;
      }
    } catch (err) {
      return {
        ok: false,
        phase: "backup",
        error: `Could not create/retain backup before final save: ${
          err instanceof Error ? err.message : String(err)
        }`,
        report,
        finalSaveValidation,
      };
    }
  }
  // ── Status-safe VBA finalize on local staged XLSM (no conflicting status run)
  const macro = await finalizeReconciledWorkbookWithoutConflictingStatusVba({
    localWorkbookPath: meta.stagedFilePath,
    masterFileId: meta.masterFileId,
    masterFileName: meta.masterFileName,
  });

  if (!macro.ok) {
    await clearPreviousStaging();
    return {
      ok: false,
      phase: "macro",
      error:
        macro.errorMessage ||
        `Status-safe VBA finalize failed for ${macro.macroName}. Final XLSM was not confirmed saved.`,
      macro,
      report,
      finalSaveValidation,
    };
  }

  // finalizeReconciledWorkbookWithoutConflictingStatusVba already uploads.
  // Re-verify Drive file is still XLSM before reporting success.
  const verified = await verifyDriveFileIsXlsm(
    meta.masterFileId,
    meta.masterFileName
  );
  if (!verified.ok) {
    await clearPreviousStaging();
    return {
      ok: false,
      phase: "save",
      error: verified.error,
      macro,
      report,
      finalSaveValidation,
    };
  }

  await clearPreviousStaging();
  return {
    ok: true,
    masterFileId: meta.masterFileId,
    masterFileName: meta.masterFileName,
    report,
    updatedAt: new Date().toISOString(),
    macro,
    finalSaveValidation,
    backupFileId,
    backupFileName,
    finalSaveVerified: true,
  };
}

/**
 * Cancel & Rollback — discard staged file and restore Master from backup
 * (Drive master was never overwritten by reconcile, but we restore from backup
 * to be safe if New Sheet phase already changed the file and user wants pre-reconcile state).
 *
 * Actually: New Sheet already saved to the same master file. Rollback restores the
 * Drive backup taken at start of reconciliation (which includes updated New Sheet).
 * Wait — backup is taken AFTER New Sheet save, from current Drive download.
 * So backup = Master with updated New Sheet, before Master Sheet status changes.
 * Cancel: restore that backup onto the master file ID = discard Master Sheet status changes.
 * Staged file discarded. Perfect.
 */
export async function cancelReconciliationRollback(): Promise<
  | {
      ok: true;
      message: string;
      restoredFromBackup: boolean;
      backupFileName: string | null;
    }
  | { ok: false; error: string }
> {
  const meta = await readReconciliationStaging();
  if (!meta) {
    return { ok: false, error: "No pending reconciliation to cancel." };
  }

  try {
    let restoredFromBackup = false;

    // Prefer restoring local original copy (exact bytes before reconcile edits)
    if (existsSync(meta.originalLocalPath)) {
      await updateDriveFile(
        meta.masterFileId,
        meta.originalLocalPath,
        meta.masterFileName
      );
      restoredFromBackup = true;
    } else if (meta.backupFileId) {
      // Download Drive backup and restore onto master file
      const backupLocal = await downloadToTemp(
        meta.backupFileId,
        meta.backupFileName || meta.masterFileName
      );
      try {
        await updateDriveFile(
          meta.masterFileId,
          backupLocal,
          meta.masterFileName
        );
        restoredFromBackup = true;
      } finally {
        await fs.unlink(backupLocal).catch(() => undefined);
      }
    }

    await clearPreviousStaging();

    return {
      ok: true,
      restoredFromBackup,
      backupFileName: meta.backupFileName,
      message: restoredFromBackup
        ? "Cancelled. Previous Master Workbook version restored. Staged reconciliation discarded."
        : "Cancelled. Staged reconciliation discarded. Drive Master was not overwritten by reconcile.",
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Failed to cancel and rollback reconciliation.",
    };
  }
}

/**
 * Drive-free local Master reconciliation for safe offline / E2E tests.
 * Runs the same Python status engine used in production staging.
 * Does NOT upload, backup, or mutate any Google Drive file.
 */
export async function reconcileMasterWorkbookLocally(input: {
  inputPath: string;
  outputPath: string;
  masterSheetName?: string;
  newSheetName?: string;
  todayDDMMYYYY?: string;
}): Promise<{
  ok: boolean;
  error?: string;
  summary?: ReconciliationSummary;
  details?: ReconciliationDetailRow[];
  validation?: ReconciliationReport["validation"] & {
    ok?: boolean;
    reasons?: string[];
  };
  raw?: unknown;
}> {
  const masterSheetName = input.masterSheetName || DEFAULT_LATERAL_MASTER_SHEET;
  const newSheetName = input.newSheetName || DEFAULT_LATERAL_NEW_SHEET;
  const today = input.todayDDMMYYYY || formatProcessingDateDDMMYYYY(new Date());

  const scriptPath = path.join(
    os.tmpdir(),
    `lateral-reconcile-local-${Date.now()}.py`
  );
  await fs.writeFile(scriptPath, buildPythonScript(), "utf8");

  try {
    const result = await execFileAsync(
      "python",
      [
        scriptPath,
        input.inputPath,
        input.outputPath,
        masterSheetName,
        newSheetName,
        today,
      ],
      {
        windowsHide: true,
        timeout: 300_000,
        maxBuffer: 32 * 1024 * 1024,
      }
    );
    const stdout = (result.stdout || "").trim();
    const payload = JSON.parse(stdout || "{}") as {
      ok?: boolean;
      error?: string;
      summary?: ReconciliationSummary;
      details?: ReconciliationDetailRow[];
      validation?: ReconciliationReport["validation"] & {
        ok?: boolean;
        reasons?: string[];
      };
    };

    if (!payload.ok) {
      return {
        ok: false,
        error: payload.error || "Local reconciliation failed.",
        validation: payload.validation,
        raw: payload,
      };
    }

    return {
      ok: true,
      summary: payload.summary,
      details: payload.details,
      validation: payload.validation,
      raw: payload,
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Local reconciliation process failed.",
    };
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}
