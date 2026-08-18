/**
 * Inspect a local Master XLSM for final-save validation (read-only).
 * Uses openpyxl keep_vba=True — never writes, never converts to XLSX.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  JOB_REQUISITION_ID_HEADER,
  MASTER_DATE_HEADER,
  MASTER_JOB_STATUS_COLUMN_K,
  MASTER_JOB_STATUS_HEADER,
} from "@/services/lateral-processing/lateral-job-status-rules";
import type { FinalMasterSaveWorkbookSnapshot } from "@/services/lateral-processing/lateral-final-master-save";
import { isXlsmMasterFilename } from "@/services/lateral-processing/lateral-master-workbook-discovery";

const execFileAsync = promisify(execFile);

function buildInspectScript(): string {
  return `
import json, sys
from openpyxl import load_workbook
from datetime import datetime, date

path = sys.argv[1]
master_name = sys.argv[2]
new_name = sys.argv[3]
file_name = sys.argv[4]

JOB_ID = ${JSON.stringify(JOB_REQUISITION_ID_HEADER)}
DATE = ${JSON.stringify(MASTER_DATE_HEADER)}
STATUS = ${JSON.stringify(MASTER_JOB_STATUS_HEADER)}
STATUS_COL_K = ${MASTER_JOB_STATUS_COLUMN_K}

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

try:
    wb = load_workbook(path, keep_vba=True, data_only=False)
except Exception as e:
    print(json.dumps({"ok": False, "error": f"Failed to open workbook with VBA: {e}"}))
    sys.exit(0)

if master_name not in wb.sheetnames or new_name not in wb.sheetnames:
    print(json.dumps({
        "ok": False,
        "error": f'Missing worksheets. Need "{master_name}" and "{new_name}". Available: {", ".join(wb.sheetnames)}'
    }))
    sys.exit(0)

ws_m = wb[master_name]
ws_n = wb[new_name]

def headers(ws, max_cols=20):
    out = []
    for c in range(1, max_cols + 1):
        out.append(norm(ws.cell(1, c).value))
    # trim trailing empties but keep at least 11 for Master K
    while len(out) > 11 and out[-1] == "":
        out.pop()
    return out

mh = headers(ws_m, max(20, STATUS_COL_K))
nh = headers(ws_n, 12)

# New Sheet JR + Date cols by header name
n_job = n_date = None
for i, h in enumerate(nh, start=1):
    if h == JOB_ID:
        n_job = i
    if h == DATE:
        n_date = i

m_job = m_date = None
for i, h in enumerate(mh, start=1):
    if h == JOB_ID:
        m_job = i
    if h == DATE:
        m_date = i

new_rows = []
if n_job and n_date:
    for r in range(2, (ws_n.max_row or 1) + 1):
        jid = norm(ws_n.cell(r, n_job).value)
        if not jid:
            continue
        new_rows.append({
            "date": fmt_date(ws_n.cell(r, n_date).value),
            "jobRequisitionId": jid,
        })

master_rows = []
if m_job and m_date:
    for r in range(2, (ws_m.max_row or 1) + 1):
        jid = norm(ws_m.cell(r, m_job).value)
        if not jid:
            continue
        master_rows.append({
            "rowNumber": r,
            "date": fmt_date(ws_m.cell(r, m_date).value),
            "jobRequisitionId": jid,
            "status": norm(ws_m.cell(r, STATUS_COL_K).value),
        })

# VBA project hint: vba_archive present when keep_vba loaded an xlsm with macros
has_vba = getattr(wb, "vba_archive", None) is not None

wb.close()

import os
ext = os.path.splitext(file_name)[1].lower()
print(json.dumps({
    "ok": True,
    "snapshot": {
        "fileName": file_name,
        "extension": ext,
        "masterSheetName": master_name,
        "newSheetName": new_name,
        "newSheetHeaders": nh[:10] if len(nh) >= 10 else nh,
        "newSheetRows": new_rows,
        "masterHeaders": mh,
        "masterRows": master_rows,
        "isXlsm": ext == ".xlsm",
        "keepVbaTrue": True,
        "hasVbaArchive": has_vba,
    }
}))
`.trim();
}

export async function inspectLocalMasterWorkbookForFinalSave(options: {
  localPath: string;
  fileName: string;
  masterSheetName: string;
  newSheetName: string;
  todayDDMMYYYY: string;
  expectedClosedIds?: string[];
  expectedNewIds?: string[];
}): Promise<
  | { ok: true; snapshot: FinalMasterSaveWorkbookSnapshot }
  | { ok: false; error: string }
> {
  if (!isXlsmMasterFilename(options.fileName)) {
    return {
      ok: false,
      error: `Final save inspection refused: "${options.fileName}" is not XLSM.`,
    };
  }

  const scriptPath = path.join(
    os.tmpdir(),
    `lateral-final-save-inspect-${Date.now()}.py`
  );
  try {
    await fs.writeFile(scriptPath, buildInspectScript(), "utf8");
    const { stdout } = await execFileAsync(
      "python",
      [
        scriptPath,
        options.localPath,
        options.masterSheetName,
        options.newSheetName,
        options.fileName,
      ],
      {
        windowsHide: true,
        timeout: 180_000,
        maxBuffer: 32 * 1024 * 1024,
      }
    );
    const parsed = JSON.parse((stdout || "").trim() || "{}") as {
      ok?: boolean;
      error?: string;
      snapshot?: Omit<
        FinalMasterSaveWorkbookSnapshot,
        "todayDDMMYYYY" | "expectedClosedIds" | "expectedNewIds"
      > & { hasVbaArchive?: boolean };
    };
    if (!parsed.ok || !parsed.snapshot) {
      return {
        ok: false,
        error: parsed.error || "Failed to inspect Master Workbook for final save.",
      };
    }
    const snap = parsed.snapshot;
    return {
      ok: true,
      snapshot: {
        ...snap,
        keepVbaTrue: snap.keepVbaTrue && snap.hasVbaArchive !== false,
        todayDDMMYYYY: options.todayDDMMYYYY,
        expectedClosedIds: options.expectedClosedIds,
        expectedNewIds: options.expectedNewIds,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Final save inspection failed: ${err.message}`
          : "Final save inspection failed.",
    };
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}
