/**
 * Shared, read-only Drive download + raw-tab-read for the new "Posted"
 * button. Dataset-agnostic — Lateral's and Executive's Posted services both
 * call this with their own file id / sheet name.
 *
 * Deliberately separate from `executive-posted-sheet-reader.ts` and
 * `lateral-posted-sheet-processor.ts`: this feature downloads fresh from
 * Drive on every click (never a pipeline-staged copy) and never writes
 * anything — writing happens in a later step, on the same local temp copy,
 * only in Stage 2 and only behind `ARA_POSTED_WRITES_ENABLED`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { drive_v3 } from "googleapis";

const execFileAsync = promisify(execFile);

export interface PostedWorkbookMeta {
  fileId: string;
  fileName: string;
  mimeType: string | null;
  /** Captured for the Stage 2 live-edit race check (re-fetched before the final write). */
  modifiedTime: string | null;
  headRevisionId: string | null;
}

export async function fetchPostedWorkbookMeta(
  drive: drive_v3.Drive,
  fileId: string
): Promise<PostedWorkbookMeta> {
  const res = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, trashed, modifiedTime, headRevisionId",
    supportsAllDrives: true,
  });
  if (!res.data.id || res.data.trashed) {
    throw new Error(
      res.data.trashed
        ? `Workbook "${res.data.name ?? fileId}" is in Google Drive trash.`
        : `Workbook (id=${fileId}) was not found.`
    );
  }
  return {
    fileId: res.data.id,
    fileName: res.data.name ?? fileId,
    mimeType: res.data.mimeType ?? null,
    modifiedTime: res.data.modifiedTime ?? null,
    headRevisionId: res.data.headRevisionId ?? null,
  };
}

export async function downloadPostedWorkbookToTemp(
  drive: drive_v3.Drive,
  fileId: string,
  fileName: string
): Promise<string> {
  const safe = (fileName || fileId).replace(/[^\w.-]+/g, "_");
  const tempPath = path.join(os.tmpdir(), `posted-button-${Date.now()}-${safe}`);
  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(tempPath, Buffer.from(response.data as ArrayBuffer));
  return tempPath;
}

export interface PostedSheetRawRow {
  rowNumber: number;
  columnA: unknown;
  columnB: unknown;
  columnC: unknown;
}

export type PostedSheetRawReadResult =
  | { ok: true; rows: PostedSheetRawRow[] }
  | { ok: false; reason: string };

/**
 * Read a tab's raw column A, row-by-row, with real 1-based sheet row
 * numbers preserved (needed later for a real row delete, not just a
 * cleared value). Read-only — `data_only=True, read_only=True` never
 * mutates the file on disk.
 */
export async function readPostedSheetTabRaw(
  localPath: string,
  sheetName: string
): Promise<PostedSheetRawReadResult> {
  const scriptPath = path.join(os.tmpdir(), `posted-sheet-read-${Date.now()}.py`);
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
rows = []
row_number = 0
for row in ws.iter_rows(values_only=True):
    row_number += 1
    if row_number == 1:
        continue  # header
    column_a = row[0] if len(row) > 0 else None
    column_b = row[1] if len(row) > 1 else None
    column_c = row[2] if len(row) > 2 else None
    rows.append({"rowNumber": row_number, "columnA": column_a, "columnB": column_b, "columnC": column_c})
wb.close()
print(json.dumps({"ok": True, "rows": rows}))
`.trim();

  await fs.writeFile(scriptPath, script, "utf8");
  try {
    const { stdout } = await execFileAsync("python3", [scriptPath, localPath, sheetName], {
      windowsHide: true,
      timeout: 300_000,
      maxBuffer: 256 * 1024 * 1024,
    });
    const parsed = JSON.parse((stdout || "").trim()) as
      | { ok: true; rows: PostedSheetRawRow[] }
      | { ok: false; error: string };
    if (!parsed.ok) return { ok: false, reason: parsed.error };
    return { ok: true, rows: parsed.rows };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? `Failed to read Posted Sheet: ${error.message}` : "Failed to read Posted Sheet.",
    };
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}
