/**
 * Executive Posted Sheet reader (Phase E6).
 *
 * Downloads the configured Drive .xlsm workbook (media download, same
 * pattern as `pipeline.ts`'s `downloadDriveFileToTemp`-equivalent), then
 * reads the "Posted Sheet" tab via Python/openpyxl `data_only=True` — same
 * calculated-value technique used for the demand sheet (Phase E3) and
 * Lateral's own New Sheet reads, appropriate here too even though Posted
 * Sheet has no confirmed error-blanking requirement (unlike the demand
 * sheet): reading calculated values rather than formulas is simply correct
 * by default for any cell that might be a formula.
 *
 * Never writes to the workbook. Every failure mode (file not found, trashed,
 * tab missing, unreadable, zero data rows) surfaces as a typed `ok:false`
 * result — callers must treat this as "skip and warn", never as "empty
 * sheet found, so clear everyone's posted value" (see
 * `executive-posted-refresh.ts`).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { drive_v3 } from "googleapis";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import {
  EXECUTIVE_POSTED_SHEET_TAB_NAME,
  resolveExecutivePostedSheetDriveFileId,
} from "@/services/executive-processing/executive-posted-sheet-config";

const execFileAsync = promisify(execFile);

export interface ExecutivePostedSheetRow {
  jobRequisitionId: string;
  demand: string;
}

export type ExecutivePostedSheetReadResult =
  | { ok: true; rows: ExecutivePostedSheetRow[]; fileName: string }
  | { ok: false; reason: string };

async function downloadDriveFileToTemp(
  drive: drive_v3.Drive,
  fileId: string,
  fileName: string
): Promise<string> {
  const safe = (fileName || fileId).replace(/[^\w.-]+/g, "_");
  const tempPath = path.join(
    os.tmpdir(),
    `executive-posted-sheet-${Date.now()}-${safe}`
  );
  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(tempPath, Buffer.from(response.data as ArrayBuffer));
  return tempPath;
}

async function readPostedSheetTab(
  localPath: string,
  sheetName: string
): Promise<
  | { ok: true; headers: string[]; dataRows: string[][] }
  | { ok: false; reason: string }
> {
  const scriptPath = path.join(
    os.tmpdir(),
    `executive-posted-sheet-read-${Date.now()}.py`
  );
  const script = `
import json, sys
from openpyxl import load_workbook
path, sheet_name = sys.argv[1], sys.argv[2]
wb = load_workbook(path, read_only=True, data_only=True)
if sheet_name not in wb.sheetnames:
    print(json.dumps({"ok": False, "error": 'Worksheet "%s" not found. Available: %s' % (sheet_name, ", ".join(wb.sheetnames))}))
    wb.close()
    raise SystemExit(0)
ws = wb[sheet_name]
headers = []
header_seen = False
data_rows = []
for row in ws.iter_rows(values_only=True):
    values = [("" if c is None else str(c)) for c in row]
    if not header_seen:
        if any(str(v).strip() for v in values):
            headers = [str(v).strip() for v in values]
            while headers and not headers[-1]:
                headers.pop()
            header_seen = True
        continue
    if not any(str(v).strip() for v in values):
        continue
    data_rows.append([(values[i] if i < len(values) else "") for i in range(len(headers))])
wb.close()
if not header_seen or not headers:
    print(json.dumps({"ok": False, "error": 'Worksheet "%s" appears empty.' % sheet_name}))
else:
    print(json.dumps({"ok": True, "headers": headers, "dataRows": data_rows}))
`.trim();

  await fs.writeFile(scriptPath, script, "utf8");
  try {
    const { stdout } = await execFileAsync(
      "python3",
      [scriptPath, localPath, sheetName],
      { windowsHide: true, timeout: 300_000, maxBuffer: 256 * 1024 * 1024 }
    );
    const parsed = JSON.parse((stdout || "").trim()) as
      | { ok: true; headers: string[]; dataRows: string[][] }
      | { ok: false; error: string };
    if (!parsed.ok) return { ok: false, reason: parsed.error };
    return { ok: true, headers: parsed.headers, dataRows: parsed.dataRows };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error
          ? `Failed to read Posted Sheet: ${error.message}`
          : "Failed to read Posted Sheet.",
    };
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

function normalizeHeaderKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function findHeaderIndex(headers: string[], wanted: string): number {
  let idx = headers.findIndex((h) => h === wanted);
  if (idx >= 0) return idx;
  idx = headers.findIndex((h) => h.toLowerCase() === wanted.toLowerCase());
  if (idx >= 0) return idx;
  const norm = normalizeHeaderKey(wanted);
  return headers.findIndex((h) => normalizeHeaderKey(h) === norm);
}

/**
 * Read the configured Posted Sheet workbook's "Posted Sheet" tab.
 * Matches columns by header name (exact -> case-insensitive -> normalized),
 * same philosophy as every other confirmed mapping in this pipeline —
 * "Job Requisition ID" and "Demand" are expected to sit in columns B and C
 * per the confirmed layout, but matching by name tolerates a column being
 * reordered without silently reading the wrong data.
 */
export async function readExecutivePostedSheet(options?: {
  driveFileId?: string;
  sheetName?: string;
  drive?: drive_v3.Drive;
}): Promise<ExecutivePostedSheetReadResult> {
  const fileId = options?.driveFileId || resolveExecutivePostedSheetDriveFileId();
  const sheetName = options?.sheetName?.trim() || EXECUTIVE_POSTED_SHEET_TAB_NAME;

  let drive = options?.drive;
  if (!drive) {
    try {
      const client = await getAuthorizedGmailClient();
      drive = client.drive;
    } catch (error) {
      return {
        ok: false,
        reason:
          error instanceof Error
            ? `Google Drive connection unavailable: ${error.message}`
            : "Google Drive connection unavailable.",
      };
    }
  }

  let meta: { name: string; trashed: boolean } | null = null;
  try {
    const res = await drive.files.get({
      fileId,
      fields: "id, name, trashed",
      supportsAllDrives: true,
    });
    if (res.data.id) {
      meta = { name: res.data.name ?? fileId, trashed: Boolean(res.data.trashed) };
    }
  } catch (error) {
    return {
      ok: false,
      reason: `Posted Sheet workbook (Drive id=${fileId}) was not found or is not accessible: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }

  if (!meta) {
    return { ok: false, reason: `Posted Sheet workbook (Drive id=${fileId}) was not found.` };
  }
  if (meta.trashed) {
    return {
      ok: false,
      reason: `Posted Sheet workbook "${meta.name}" is in Google Drive trash — treated as unreadable, not restored automatically.`,
    };
  }

  let localPath: string;
  try {
    localPath = await downloadDriveFileToTemp(drive, fileId, meta.name);
  } catch (error) {
    return {
      ok: false,
      reason: `Failed to download Posted Sheet workbook "${meta.name}": ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }

  try {
    const sheet = await readPostedSheetTab(localPath, sheetName);
    if (!sheet.ok) return { ok: false, reason: sheet.reason };

    const jrIdx = findHeaderIndex(sheet.headers, "Job Requisition ID");
    const demandIdx = findHeaderIndex(sheet.headers, "Demand");
    if (jrIdx < 0 || demandIdx < 0) {
      return {
        ok: false,
        reason: `Posted Sheet tab is missing required column(s): ${[
          jrIdx < 0 ? "Job Requisition ID" : null,
          demandIdx < 0 ? "Demand" : null,
        ]
          .filter(Boolean)
          .join(", ")}.`,
      };
    }

    const rows: ExecutivePostedSheetRow[] = [];
    for (const row of sheet.dataRows) {
      const jobRequisitionId = String(row[jrIdx] ?? "").trim();
      const demand = String(row[demandIdx] ?? "").trim();
      if (!jobRequisitionId && !demand) continue;
      rows.push({ jobRequisitionId, demand });
    }

    if (rows.length === 0) {
      return {
        ok: false,
        reason: `Posted Sheet tab "${sheetName}" has a header row but zero usable data rows.`,
      };
    }

    return { ok: true, rows, fileName: meta.name };
  } finally {
    await fs.unlink(localPath).catch(() => undefined);
  }
}
