/**
 * Executive demand-sheet ("Base DS") reader (Phase E3).
 *
 * Reads via Python/openpyxl with `data_only=True`, mirroring the exact
 * technique `lateral-master-job-status-sync.ts` already uses to read
 * Lateral's New Sheet — `data_only=True` returns each cell's last-CALCULATED
 * value, never the formula text, and represents a cached formula error
 * (e.g. a broken external-link `#REF!`) as that literal error string. This
 * satisfies the confirmed rule: read the calculated value, never the
 * formula; error codes are detected downstream in
 * `executive-base-ds-mapping.ts` (`classifyExecutiveExcelError`) and
 * blanked + logged, never stored.
 *
 * This is a fresh module — NOT the abandoned `src/services/dataset/
 * executive-base-ds-reader.ts` (that one reads via ExcelJS with no
 * error-value handling, for the superseded "New Sheet" destination model;
 * left untouched for Phase E7 cleanup).
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EXECUTIVE_BASE_DS_SHEET_NAME } from "@/services/executive-processing/executive-base-ds-mapping";

const execFileAsync = promisify(execFile);

export interface ExecutiveBaseDsSheetRead {
  headers: string[];
  dataRows: string[][];
}

export class ExecutiveBaseDsReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutiveBaseDsReadError";
  }
}

/**
 * Read the Base DS sheet from a local .xlsx file.
 * Calculated values only (data_only=True) — never formulas.
 * Throws ExecutiveBaseDsReadError with a clear message when the sheet or
 * file is missing/unreadable; never silently returns empty data.
 */
export async function readExecutiveBaseDsSheet(
  localWorkbookPath: string,
  sheetName: string = EXECUTIVE_BASE_DS_SHEET_NAME
): Promise<ExecutiveBaseDsSheetRead> {
  if (!localWorkbookPath || !existsSync(localWorkbookPath)) {
    throw new ExecutiveBaseDsReadError(
      `Executive demand-sheet workbook not found at "${localWorkbookPath}".`
    );
  }

  const scriptPath = path.join(
    os.tmpdir(),
    `executive-base-ds-read-${Date.now()}.py`
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
      [scriptPath, localWorkbookPath, sheetName],
      { windowsHide: true, timeout: 300_000, maxBuffer: 256 * 1024 * 1024 }
    );
    const parsed = JSON.parse((stdout || "").trim()) as
      | { ok: true; headers: string[]; dataRows: string[][] }
      | { ok: false; error: string };
    if (!parsed.ok) {
      throw new ExecutiveBaseDsReadError(parsed.error);
    }
    if (parsed.headers.length === 0) {
      throw new ExecutiveBaseDsReadError(
        `Base DS sheet "${sheetName}" has no header row.`
      );
    }
    if (parsed.dataRows.length === 0) {
      throw new ExecutiveBaseDsReadError(
        `Base DS sheet "${sheetName}" has no data rows.`
      );
    }
    return { headers: parsed.headers, dataRows: parsed.dataRows };
  } catch (error) {
    if (error instanceof ExecutiveBaseDsReadError) throw error;
    throw new ExecutiveBaseDsReadError(
      error instanceof Error
        ? `Failed to read Base DS sheet: ${error.message}`
        : "Failed to read Base DS sheet."
    );
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}
