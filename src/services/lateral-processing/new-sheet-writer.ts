/**
 * new-sheet-writer.ts
 *
 * New Sheet refresh (runs only after prior Lateral gates succeed):
 *   1. Download master workbook from Drive
 *   2. Validate New Sheet Row 1 header structure (exact A–J order)
 *   3. Read ATCI DS + map by HEADER NAME (Date generated) — STOP on failure
 *   4. Create backup/version of Master Workbook
 *   5. Keep Row 1; delete ONLY data rows below Row 1 (never delete/recreate sheet)
 *   6. Insert mapped ATCI DS rows; Column A = processing date DD-MM-YYYY
 *   7. Validate (row counts, headers, Date, Job Requisition ID, no shifts)
 *   8. On validation/save failure → rollback to previous workbook version
 *   9. Upload updated master workbook to Drive ONLY when commitToProduction is true.
 *      Pipeline / Run All must pass commitToProduction: false and keep the local
 *      edited XLSM until P-Roles + final validation succeed.
 */

import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import type { LateralDataProcessingSetup } from "@/types/lateral-processing-setup";
import { parseDriveFolderIdFromUrl } from "@/services/drive/folder";
import type { ColumnMapping } from "@/services/lateral-processing/data-reader";
import { mapAtciDsToNewSheet } from "@/services/lateral-processing/lateral-column-mapping";
import {
  formatProcessingDateDDMMYYYY,
  validateNewSheetRefresh,
} from "@/services/lateral-processing/lateral-new-sheet-refresh";
import { EXPECTED_NEW_SHEET_HEADERS } from "@/services/lateral-processing/lateral-new-sheet-structure";

const execFileAsync = promisify(execFile);

// ─── public result types ─────────────────────────────────────────────────────

export interface NewSheetWriteSuccess {
  ok: true;
  backupFileId: string;
  backupFileName: string;
  sourceRowsRead: number;
  rowsWritten: number;
  masterFileId: string;
  masterFileName: string;
  updatedAt: string;
  columnMappings: ColumnMapping[];
  unmatchedSourceHeaders: string[];
  validationPassed: boolean;
  /** Processing date written to Column A (DD-MM-YYYY) */
  processingDate: string;
  /**
   * Local edited XLSM path. Present when commitToProduction is false.
   * Caller must delete after staging / final commit.
   */
  localEditedPath?: string;
  /** False when production Drive Master was not updated. */
  committedToProduction: boolean;
}

export interface NewSheetWriteFailure {
  ok: false;
  phase:
    | "header_structure"
    | "backup"
    | "read_source"
    | "column_mapping"
    | "write_new_sheet"
    | "validation"
    | "save_to_drive";
  error: string;
  rolledBack: boolean;
  missingDestinationHeaders?: string[];
  availableSourceHeaders?: string[];
}

export type NewSheetWriteResult = NewSheetWriteSuccess | NewSheetWriteFailure;

// ─── internal helpers ─────────────────────────────────────────────────────────

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

async function downloadToTemp(
  fileId: string,
  nameHint: string,
  tag: string
): Promise<string> {
  const { drive } = await getAuthorizedGmailClient();
  const safeName = (nameHint || fileId).replace(/[^\w.-]+/g, "_");
  const tempPath = path.join(
    os.tmpdir(),
    `lateral-write-${tag}-${Date.now()}-${safeName}`
  );
  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(tempPath, Buffer.from(response.data as ArrayBuffer));
  return tempPath;
}

/** Convert .xlsm → plain .xlsx via Python openpyxl (strip VBA) so ExcelJS can read it */
async function toReadableXlsx(filePath: string): Promise<{ path: string; owned: boolean }> {
  if (!filePath.toLowerCase().endsWith(".xlsm")) {
    return { path: filePath, owned: false };
  }
  const outPath = filePath.replace(/\.xlsm$/i, "__rw.xlsx");
  const script = [
    "from openpyxl import load_workbook",
    "import sys",
    "wb = load_workbook(sys.argv[1], read_only=False, keep_vba=False, data_only=True)",
    // Drop Excel Tables — ExcelJS crashes on undefined/broken table models
    "for ws in wb.worksheets:",
    "    tables = getattr(ws, 'tables', None)",
    "    if tables is not None:",
    "        for key in list(tables.keys()):",
    "            del tables[key]",
    "wb.save(sys.argv[2])",
    "wb.close()",
  ].join(";");
  await execFileAsync("python", ["-c", script, filePath, outPath], {
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { path: outPath, owned: true };
}

function cellToString(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && "richText" in v) {
    return (v as ExcelJS.CellRichTextValue).richText
      .map((c) => c?.text ?? "")
      .join("");
  }
  if (typeof v === "object" && "result" in v) {
    const r = (v as ExcelJS.CellFormulaValue).result;
    return r == null ? "" : String(r);
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/** Read all rows via openpyxl — required for complex Accenture .xlsm masters. */
async function readAllRowsWithPython(
  filePath: string,
  sheetName: string
): Promise<{ headers: string[]; dataRows: Array<Array<string>> }> {
  const scriptPath = path.join(
    os.tmpdir(),
    `lateral-write-read-${Date.now()}-${Math.random().toString(16).slice(2)}.py`
  );
  const script = `
import json, sys
from openpyxl import load_workbook

path, sheet_name = sys.argv[1], sys.argv[2]
wb = load_workbook(path, read_only=True, data_only=True, keep_vba=True)
if sheet_name not in wb.sheetnames:
    print(json.dumps({"ok": False, "error": 'Worksheet "%s" not found. Available: %s' % (sheet_name, ", ".join(wb.sheetnames))}))
    wb.close()
    raise SystemExit(0)
ws = wb[sheet_name]
headers = []
header_row_idx = None
data_rows = []
for i, row in enumerate(ws.iter_rows(values_only=True), start=1):
    values = [("" if c is None else str(c).strip()) for c in row]
    if header_row_idx is None:
        if any(v for v in values):
            headers = values
            while headers and not headers[-1]:
                headers.pop()
            header_row_idx = i
        continue
    if not any(v for v in values):
        continue
    # Keep columns aligned to header width
    row_vals = []
    for idx in range(len(headers)):
        row_vals.append(values[idx] if idx < len(values) else "")
    data_rows.append(row_vals)
wb.close()
if header_row_idx is None or not headers:
    print(json.dumps({"ok": False, "error": 'Worksheet "%s" appears to be empty.' % sheet_name}))
else:
    print(json.dumps({"ok": True, "headers": headers, "dataRows": data_rows}))
`.trim();

  await fs.writeFile(scriptPath, script, "utf8");
  try {
    const result = await execFileAsync(
      "python",
      [scriptPath, filePath, sheetName],
      {
        windowsHide: true,
        timeout: 300_000,
        maxBuffer: 256 * 1024 * 1024,
      }
    );
    const parsed = JSON.parse((result.stdout || "").trim()) as
      | { ok: true; headers: string[]; dataRows: Array<Array<string>> }
      | { ok: false; error: string };
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    return { headers: parsed.headers, dataRows: parsed.dataRows };
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

async function readAllRowsWithExcelJs(
  filePath: string,
  sheetName: string
): Promise<{ headers: string[]; dataRows: Array<Array<string>> }> {
  const { path: readPath, owned } = await toReadableXlsx(filePath);
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(readPath);
    const ws = wb.getWorksheet(sheetName);
    if (!ws) {
      const avail = wb.worksheets.map((s) => s.name).join(", ");
      throw new Error(`Worksheet "${sheetName}" not found. Available: ${avail}`);
    }

    let headers: string[] = [];
    let headerRowIndex = -1;
    const dataRows: Array<Array<string>> = [];

    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells = row.values as (ExcelJS.CellValue | undefined)[];
      if (headerRowIndex === -1) {
        const hasContent = cells
          .slice(1)
          .some((c) => c !== null && c !== undefined && String(c).trim() !== "");
        if (hasContent) {
          headerRowIndex = rowNumber;
          headers = cells
            .slice(1)
            .map((c) => (c == null ? "" : String(c).trim()));
        }
        return;
      }
      const rowArr: string[] = [];
      for (let col = 1; col <= Math.max(headers.length, cells.length - 1); col++) {
        const cell = row.getCell(col);
        rowArr.push(cellToString(cell));
      }
      dataRows.push(rowArr);
    });

    return { headers, dataRows };
  } finally {
    if (owned) await fs.unlink(readPath).catch(() => undefined);
  }
}

/** Read all rows from a sheet: returns [headers, dataRows] */
async function readAllRows(
  filePath: string,
  sheetName: string
): Promise<{ headers: string[]; dataRows: Array<Array<string>> }> {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".xlsm") || lower.endsWith(".xls")) {
    return readAllRowsWithPython(filePath, sheetName);
  }
  try {
    return await readAllRowsWithExcelJs(filePath, sheetName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      return await readAllRowsWithPython(filePath, sheetName);
    } catch {
      throw err instanceof Error ? err : new Error(message);
    }
  }
}

/** Upload a local BACKUP file to Drive (always creates — never replaces Master). */
async function uploadToDrive(
  localPath: string,
  fileName: string,
  folderId: string,
  masterFileName?: string | null
): Promise<{ fileId: string; webViewLink: string | null }> {
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

  const created = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId], mimeType },
    media: { mimeType, body: createReadStream(localPath) },
    fields: "id,name,webViewLink,mimeType",
    supportsAllDrives: true,
  });

  if (!created.data.id) throw new Error("Drive upload did not return a file ID.");
  if (created.data.mimeType?.startsWith("application/vnd.google-apps.")) {
    throw new Error(
      `Drive converted "${fileName}" to ${created.data.mimeType}. ` +
        "Expected a native Excel file. Ensure mimeType is set correctly."
    );
  }
  const createdName = created.data.name ?? fileName;
  const master = (masterFileName || "").trim().toLowerCase();
  if (master && createdName.toLowerCase() === master) {
    throw new Error(
      `Backup upload unexpectedly used Master identity name "${createdName}". Aborting.`
    );
  }
  return { fileId: created.data.id, webViewLink: created.data.webViewLink ?? null };
}

/** Update an existing Drive file's content in place (for saving the edited master) */
async function updateDriveFileContent(
  fileId: string,
  localPath: string,
  fileName: string
): Promise<void> {
  const { drive } = await getAuthorizedGmailClient();
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
      `Refusing Master identity filename "${expectedFileName}". Master must be updated in place under the configured name.`
    );
  }
  if (!/\.xlsm$/i.test(expectedFileName)) {
    throw new Error(
      `Master Workbook must remain XLSM ("${expectedFileName}"). Refusing non-XLSM in-place update.`
    );
  }

  const mimeType =
    "application/vnd.ms-excel.sheet.macroEnabled.12";

  // Confirm identity exists — never files.create a second Master
  const existing = await drive.files.get({
    fileId,
    fields: "id,name,trashed",
    supportsAllDrives: true,
  });
  if (existing.data.trashed) {
    throw new Error(
      `Configured Master Workbook (${fileId}) is trashed. Restore it — do not create a new Master.`
    );
  }

  await drive.files.update({
    fileId,
    requestBody: { name: expectedFileName, mimeType },
    media: { mimeType, body: createReadStream(localPath) },
    fields: "id,name,modifiedTime",
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

// ─── main entry point ─────────────────────────────────────────────────────────

export async function executeNewSheetUpdate(
  setup: LateralDataProcessingSetup,
  options?: { commitToProduction?: boolean }
): Promise<NewSheetWriteResult> {
  const commitToProduction = options?.commitToProduction !== false;
  const destinationFolderId = resolveFolderId(
    setup.destinationFolder.folderUrl,
    setup.destinationFolder.folderId
  );

  const masterTempPath = await downloadToTemp(
    setup.masterWorkbook.fileId,
    setup.masterWorkbook.fileName,
    "master"
  ).catch((err: unknown) => {
    throw Object.assign(
      new Error(
        `Failed to download master workbook: ${err instanceof Error ? err.message : String(err)}`
      ),
      { phase: "backup" }
    );
  });

  // Structure gate BEFORE backup / clear / write — never rearrange or delete on mismatch.
  try {
    const {
      readNewSheetRow1HeadersFromLocal,
      validateNewSheetHeaderStructure,
    } = await import("@/services/lateral-processing/lateral-new-sheet-structure");
    const row1 = await readNewSheetRow1HeadersFromLocal(
      masterTempPath,
      setup.masterNewSheet || "New Sheet"
    );
    const structure = validateNewSheetHeaderStructure(row1);
    if (!structure.ok) {
      await fs.unlink(masterTempPath).catch(() => undefined);
      return {
        ok: false,
        phase: "header_structure",
        error: structure.message,
        rolledBack: false,
      };
    }
  } catch (err) {
    await fs.unlink(masterTempPath).catch(() => undefined);
    return {
      ok: false,
      phase: "header_structure",
      error:
        err instanceof Error
          ? err.message
          : "Failed to validate New Sheet header structure.",
      rolledBack: false,
    };
  }

  // ── Phase 1: Read ATCI DS source + map by HEADER NAME (before backup/clear)
  let sourceTempPath: string | null = null;
  try {
    sourceTempPath = await downloadToTemp(
      setup.sourceWorkbook.fileId,
      setup.sourceWorkbook.fileName,
      "source"
    );
  } catch (err) {
    await fs.unlink(masterTempPath).catch(() => undefined);
    return {
      ok: false,
      phase: "read_source",
      error: `Failed to download source workbook: ${err instanceof Error ? err.message : String(err)}`,
      rolledBack: false,
    };
  }

  let sourceHeaders: string[] = [];
  let sourceDataRows: Array<Array<string>> = [];
  try {
    const sourceRead = await readAllRows(sourceTempPath, setup.sourceWorksheet);
    sourceHeaders = sourceRead.headers;
    sourceDataRows = sourceRead.dataRows;
  } catch (err) {
    await Promise.all([
      fs.unlink(masterTempPath).catch(() => undefined),
      fs.unlink(sourceTempPath).catch(() => undefined),
    ]);
    return {
      ok: false,
      phase: "read_source",
      error: `Failed to read source worksheet "${setup.sourceWorksheet}": ${err instanceof Error ? err.message : String(err)}`,
      rolledBack: false,
    };
  }

  await fs.unlink(sourceTempPath).catch(() => undefined);
  sourceTempPath = null;

  // Destination order is New Sheet A–J (already structure-validated). Never remap by position.
  const destHeaders = [...EXPECTED_NEW_SHEET_HEADERS];
  const mappingOutcome = mapAtciDsToNewSheet(sourceHeaders, destHeaders);
  if (!mappingOutcome.ok) {
    await fs.unlink(masterTempPath).catch(() => undefined);
    return {
      ok: false,
      phase: "column_mapping",
      error: mappingOutcome.message,
      rolledBack: false,
      missingDestinationHeaders: mappingOutcome.missingHeaders,
      availableSourceHeaders: mappingOutcome.sourceHeadersFound,
    };
  }

  const mappings = mappingOutcome.mappings;
  const unmatchedSource = mappingOutcome.ignoredSourceHeaders;

  // ── Phase 2: Create backup ONLY after mapping succeeds ───────────────────
  const masterBaseName = path.basename(
    setup.masterWorkbook.fileName,
    path.extname(setup.masterWorkbook.fileName)
  );
  const masterExt = path.extname(setup.masterWorkbook.fileName) || ".xlsm";
  const backupFileName = `${masterBaseName}_BACKUP_${timestamp()}${masterExt}`;

  let backupFileId = "";
  let backupFileName_ = backupFileName;

  let usedNativeVersioning = false;
  try {
    const { drive } = await getAuthorizedGmailClient();
    await drive.revisions.update({
      fileId: setup.masterWorkbook.fileId,
      revisionId: "head",
      requestBody: { keepForever: true },
    });
    usedNativeVersioning = true;
    backupFileId = setup.masterWorkbook.fileId + "#revision";
    backupFileName_ = `${masterBaseName} (Drive version ${timestamp()})`;
  } catch {
    // Drive versioning not supported or not authorized — fall back to timestamped copy
  }

  if (!usedNativeVersioning) {
    try {
      const backupResult = await uploadToDrive(
        masterTempPath,
        backupFileName,
        destinationFolderId || setup.masterWorkbook.fileId,
        setup.masterWorkbook.fileName
      );
      backupFileId = backupResult.fileId;
    } catch (err) {
      const { drive } = await getAuthorizedGmailClient();
      const masterMeta = await drive.files
        .get({
          fileId: setup.masterWorkbook.fileId,
          fields: "parents",
          supportsAllDrives: true,
        })
        .catch(() => null);
      const masterParents = masterMeta?.data.parents ?? [];
      const fallbackFolderId = masterParents[0];
      if (!fallbackFolderId) {
        await fs.unlink(masterTempPath).catch(() => undefined);
        return {
          ok: false,
          phase: "backup",
          error: `Could not create backup: ${err instanceof Error ? err.message : String(err)}`,
          rolledBack: false,
        };
      }
      const backupResult2 = await uploadToDrive(
        masterTempPath,
        backupFileName,
        fallbackFolderId,
        setup.masterWorkbook.fileName
      );
      backupFileId = backupResult2.fileId;
    }
  }

  // ── Phase 3: Refresh New Sheet (keep Row 1; delete data rows only) ───────
  const today = formatProcessingDateDDMMYYYY();
  const editedTempPath = masterTempPath.replace(
    /(\.\w+)$/i,
    "__edited$1"
  );
  const payloadPath = path.join(
    os.tmpdir(),
    `lateral-newsheet-payload-${Date.now()}.json`
  );
  const scriptPath = path.join(
    os.tmpdir(),
    `lateral-newsheet-write-${Date.now()}.py`
  );

  let rowsWritten = 0;
  try {
    // Build rows in New Sheet column order (header-name mapping — never by position)
    const rows: string[][] = sourceDataRows.map((srcRow) => {
      const rowValues = destHeaders.map(() => "");
      for (const mapping of mappings) {
        if (mapping.generated || mapping.sourceColIndex < 0) {
          rowValues[mapping.destinationColIndex] = today;
          continue;
        }
        rowValues[mapping.destinationColIndex] =
          srcRow[mapping.sourceColIndex] ?? "";
      }
      // Column A = current processing date (DD-MM-YYYY) — never Gmail/Excel/source date
      rowValues[0] = today;
      return rowValues;
    });

    await fs.writeFile(
      payloadPath,
      JSON.stringify({
        sheetName: setup.masterNewSheet,
        headers: destHeaders,
        rows,
        processingDate: today,
      }),
      "utf8"
    );

    const py = `
import json, sys
from openpyxl import load_workbook

master_path = sys.argv[1]
out_path = sys.argv[2]
payload_path = sys.argv[3]

with open(payload_path, "r", encoding="utf-8") as f:
    payload = json.load(f)

sheet_name = payload["sheetName"]
expected_headers = payload["headers"]
rows = payload["rows"]

# Keep VBA / macros. Do NOT create or recreate worksheets.
wb = load_workbook(master_path, keep_vba=True, data_only=False)
if sheet_name not in wb.sheetnames:
    print(json.dumps({"ok": False, "error": f'Worksheet "{sheet_name}" not found.'}))
    sys.exit(0)

ws = wb[sheet_name]

# Read existing Row 1 headers — keep unchanged (do not rewrite Row 1).
# Compare case-insensitively so "locate" vs "Locate" does not stop refresh.
actual_headers = []
for col in range(1, len(expected_headers) + 1):
    v = ws.cell(1, col).value
    actual_headers.append("" if v is None else str(v).strip())

def _norm(h):
    return str(h or "").strip().lower()

if [_norm(h) for h in actual_headers] != [_norm(h) for h in expected_headers]:
    print(json.dumps({
        "ok": False,
        "error": "New Sheet Row 1 headers changed or reordered before refresh.",
        "actual": actual_headers,
        "expected": expected_headers,
    }))
    sys.exit(0)

# Delete ONLY previous data rows below Row 1. Keep worksheet + Row 1 + headers.
if ws.max_row and ws.max_row > 1:
    ws.delete_rows(2, ws.max_row - 1)

# Insert mapped ATCI DS rows (values only — do not recreate sheet / rewrite headers).
for r_idx, row_vals in enumerate(rows, start=2):
    for c_idx, val in enumerate(row_vals, start=1):
        ws.cell(row=r_idx, column=c_idx).value = val

wb.save(out_path)
wb.close()
print(json.dumps({
    "ok": True,
    "rowsWritten": len(rows),
    "headerRowPreserved": True,
}))
`.trim();

    await fs.writeFile(scriptPath, py, "utf8");
    const result = await execFileAsync(
      "python",
      [scriptPath, masterTempPath, editedTempPath, payloadPath],
      {
        windowsHide: true,
        timeout: 300_000,
        maxBuffer: 16 * 1024 * 1024,
      }
    );
    const parsed = JSON.parse((result.stdout || "").trim() || "{}") as {
      ok?: boolean;
      error?: string;
      rowsWritten?: number;
    };
    if (!parsed.ok) {
      throw new Error(parsed.error || "Python New Sheet refresh failed.");
    }
    rowsWritten = parsed.rowsWritten ?? rows.length;
  } catch (err) {
    await fs.unlink(editedTempPath).catch(() => undefined);
    await fs.unlink(masterTempPath).catch(() => undefined);
    await fs.unlink(payloadPath).catch(() => undefined);
    await fs.unlink(scriptPath).catch(() => undefined);
    return {
      ok: false,
      phase: "write_new_sheet",
      error: `Failed to refresh New Sheet: ${err instanceof Error ? err.message : String(err)}`,
      rolledBack: false,
    };
  } finally {
    await fs.unlink(payloadPath).catch(() => undefined);
    await fs.unlink(scriptPath).catch(() => undefined);
  }

  // ── Phase 4: Validate refresh — rollback if anything is wrong ────────────
  try {
    const verify = await readAllRows(editedTempPath, setup.masterNewSheet);
    const validation = validateNewSheetRefresh({
      expectedHeaders: destHeaders,
      actualHeaders: verify.headers,
      sourceRowCount: sourceDataRows.length,
      insertedRowCount: verify.dataRows.length,
      dataRows: verify.dataRows,
      processingDate: today,
      mappings,
      sourceDataRows,
    });

    if (!validation.ok || rowsWritten !== sourceDataRows.length) {
      await fs.unlink(editedTempPath).catch(() => undefined);
      // Drive master unchanged — discard local edit (rollback to pre-refresh workbook).
      await fs.unlink(masterTempPath).catch(() => undefined);

      const reasons = [...validation.reasons];
      if (rowsWritten !== sourceDataRows.length) {
        reasons.push(
          `Writer reported ${rowsWritten} row(s) but source had ${sourceDataRows.length}.`
        );
      }

      return {
        ok: false,
        phase: "validation",
        error: `New Sheet refresh validation failed — rolled back to previous workbook version. ${reasons.join(" ")}`,
        rolledBack: true,
      };
    }
  } catch (err) {
    await fs.unlink(editedTempPath).catch(() => undefined);
    await fs.unlink(masterTempPath).catch(() => undefined);
    return {
      ok: false,
      phase: "validation",
      error: `Validation read failed — rolled back: ${err instanceof Error ? err.message : String(err)}`,
      rolledBack: true,
    };
  }

  // ── Phase 5: Commit to production Drive ONLY when explicitly requested ──
  // Pipeline / Run All must keep the edited XLSM local until P-Roles + final
  // validation succeed (confirmReconciliationSave is the production commit).
  if (!commitToProduction) {
    await fs.unlink(masterTempPath).catch(() => undefined);
    return {
      ok: true,
      backupFileId,
      backupFileName: backupFileName_,
      sourceRowsRead: sourceDataRows.length,
      rowsWritten: sourceDataRows.length,
      masterFileId: setup.masterWorkbook.fileId,
      masterFileName: setup.masterWorkbook.fileName,
      updatedAt: new Date().toISOString(),
      columnMappings: mappings,
      unmatchedSourceHeaders: unmatchedSource,
      validationPassed: true,
      processingDate: today,
      localEditedPath: editedTempPath,
      committedToProduction: false,
    };
  }

  try {
    await updateDriveFileContent(
      setup.masterWorkbook.fileId,
      editedTempPath,
      setup.masterWorkbook.fileName
    );
  } catch (err) {
    // Restore previous workbook content from the pre-refresh local copy.
    let rolledBack = false;
    try {
      await updateDriveFileContent(
        setup.masterWorkbook.fileId,
        masterTempPath,
        setup.masterWorkbook.fileName
      );
      rolledBack = true;
    } catch {
      // Backup file on Drive may still be used manually.
      if (backupFileId && !backupFileId.includes("#revision")) {
        try {
          const backupLocal = await downloadToTemp(
            backupFileId,
            backupFileName_,
            "rollback"
          );
          await updateDriveFileContent(
            setup.masterWorkbook.fileId,
            backupLocal,
            setup.masterWorkbook.fileName
          );
          await fs.unlink(backupLocal).catch(() => undefined);
          rolledBack = true;
        } catch {
          rolledBack = false;
        }
      }
    }

    await fs.unlink(editedTempPath).catch(() => undefined);
    await fs.unlink(masterTempPath).catch(() => undefined);
    return {
      ok: false,
      phase: "save_to_drive",
      error: `Failed to save updated master workbook to Drive: ${err instanceof Error ? err.message : String(err)}${
        rolledBack ? " Previous workbook version was restored." : " Manual restore from backup may be required."
      }`,
      rolledBack,
    };
  } finally {
    await fs.unlink(editedTempPath).catch(() => undefined);
    await fs.unlink(masterTempPath).catch(() => undefined);
  }

  return {
    ok: true,
    backupFileId,
    backupFileName: backupFileName_,
    sourceRowsRead: sourceDataRows.length,
    rowsWritten: sourceDataRows.length,
    masterFileId: setup.masterWorkbook.fileId,
    masterFileName: setup.masterWorkbook.fileName,
    updatedAt: new Date().toISOString(),
    columnMappings: mappings,
    unmatchedSourceHeaders: unmatchedSource,
    validationPassed: true,
    processingDate: today,
    committedToProduction: true,
  };
}
