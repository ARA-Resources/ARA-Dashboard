import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import type { LateralDataProcessingSetup } from "@/types/lateral-processing-setup";
import {
  buildColumnMappingByHeaderName,
  mapAtciDsToNewSheet,
} from "@/services/lateral-processing/lateral-column-mapping";
import {
  EXPECTED_NEW_SHEET_HEADERS,
  headersMatchIgnoringCase,
} from "@/services/lateral-processing/lateral-new-sheet-structure";
import { formatProcessingDateDDMMYYYY } from "@/services/lateral-processing/lateral-new-sheet-refresh";

const execFileAsync = promisify(execFile);

const PREVIEW_ROWS = 5;

export interface ColumnMapping {
  /** Header in New Sheet (destination) — preserved in order */
  destinationHeader: string;
  /** Matched header in ATCI DS (source), or generated label */
  sourceHeader: string;
  /** 0-based column index in the source sheet; -1 = generated (not from source) */
  sourceColIndex: number;
  /** 0-based column index in the destination (New Sheet) */
  destinationColIndex: number;
  /** True when the destination value is system-generated (e.g. Date) */
  generated?: boolean;
}

export interface ColumnMappingFailure {
  ok: false;
  missingDestinationHeaders: string[];
  availableSourceHeaders: string[];
  /** Full stop message with missing / source / destination headers */
  message?: string;
}

export interface SheetReadResult {
  headers: string[];
  rowCount: number;
  colCount: number;
  /** First PREVIEW_ROWS data rows, as string cells keyed by header */
  previewRows: Array<Record<string, string>>;
}

export interface DataReadPreview {
  ok: true;
  sourceWorkbookName: string;
  sourceWorksheetName: string;
  source: SheetReadResult;
  masterWorkbookName: string;
  masterNewSheetName: string;
  masterNewSheetHeaders: string[];
  columnMappings: ColumnMapping[];
  unmatchedSourceHeaders: string[];
  previewMappedRows: Array<Record<string, string>>;
}

export type DataReadResult = DataReadPreview | ColumnMappingFailure;

// ─── internal helpers ────────────────────────────────────────────────────────

async function downloadToTemp(fileId: string, nameHint: string): Promise<string> {
  const { drive } = await getAuthorizedGmailClient();
  const safeName = (nameHint || fileId).replace(/[^\w.-]+/g, "_");
  const tempPath = path.join(os.tmpdir(), `lateral-read-${Date.now()}-${safeName}`);
  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(tempPath, Buffer.from(response.data as ArrayBuffer));
  return tempPath;
}

/** Convert .xlsm to a plain .xlsx via Python openpyxl so ExcelJS can read it */
async function toReadableXlsx(filePath: string): Promise<{ path: string; owned: boolean }> {
  if (!filePath.toLowerCase().endsWith(".xlsm")) {
    return { path: filePath, owned: false };
  }
  const outPath = filePath.replace(/\.xlsm$/i, "__readable.xlsx");
  const script = [
    "from openpyxl import load_workbook",
    "import sys",
    `wb = load_workbook(sys.argv[1], read_only=False, keep_vba=False, data_only=True)`,
    // Drop Excel Tables — ExcelJS crashes on undefined/broken table models
    // produced when converting complex .xlsm workbooks.
    "for ws in wb.worksheets:",
    "    tables = getattr(ws, 'tables', None)",
    "    if tables is not None:",
    "        for key in list(tables.keys()):",
    "            del tables[key]",
    `wb.save(sys.argv[2])`,
    "wb.close()",
  ].join(";");
  await execFileAsync("python", ["-c", script, filePath, outPath], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { path: outPath, owned: true };
}

function cellToString(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && "richText" in v) {
    return (v as ExcelJS.CellRichTextValue).richText
      .map((chunk) => chunk?.text ?? "")
      .join("");
  }
  if (typeof v === "object" && "result" in v) {
    const r = (v as ExcelJS.CellFormulaValue).result;
    return r === null || r === undefined ? "" : String(r);
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/** Prefer openpyxl for .xlsm / ExcelJS failures — Accenture masters often break ExcelJS tables. */
async function readSheetDataWithPython(
  filePath: string,
  sheetName: string
): Promise<SheetReadResult> {
  const scriptPath = path.join(
    os.tmpdir(),
    `lateral-read-sheet-${Date.now()}-${Math.random().toString(16).slice(2)}.py`
  );
  const script = `
import json, sys
from openpyxl import load_workbook

path, sheet_name, preview_n = sys.argv[1], sys.argv[2], int(sys.argv[3])
wb = load_workbook(path, read_only=True, data_only=True, keep_vba=True)
if sheet_name not in wb.sheetnames:
    print(json.dumps({"ok": False, "error": 'Worksheet "%s" not found. Available: %s' % (sheet_name, ", ".join(wb.sheetnames))}))
    wb.close()
    raise SystemExit(0)
ws = wb[sheet_name]
headers = []
header_row_idx = None
preview_rows = []
total = 0
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
    total += 1
    if len(preview_rows) < preview_n:
        record = {}
        for idx, h in enumerate(headers):
            if not h:
                continue
            record[h] = values[idx] if idx < len(values) else ""
        preview_rows.append(record)
wb.close()
if header_row_idx is None or not headers:
    print(json.dumps({"ok": False, "error": 'Worksheet "%s" appears to be empty.' % sheet_name}))
else:
    print(json.dumps({
        "ok": True,
        "headers": headers,
        "rowCount": total,
        "colCount": len(headers),
        "previewRows": preview_rows,
    }))
`.trim();

  await fs.writeFile(scriptPath, script, "utf8");
  try {
    const result = await execFileAsync(
      "python",
      [scriptPath, filePath, sheetName, String(PREVIEW_ROWS)],
      {
        windowsHide: true,
        timeout: 180_000,
        maxBuffer: 64 * 1024 * 1024,
      }
    );
    const parsed = JSON.parse((result.stdout || "").trim()) as
      | {
          ok: true;
          headers: string[];
          rowCount: number;
          colCount: number;
          previewRows: Array<Record<string, string>>;
        }
      | { ok: false; error: string };
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    return {
      headers: parsed.headers,
      rowCount: parsed.rowCount,
      colCount: parsed.colCount,
      previewRows: parsed.previewRows,
    };
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

async function readSheetDataWithExcelJs(
  filePath: string,
  sheetName: string
): Promise<SheetReadResult> {
  const { path: readPath, owned } = await toReadableXlsx(filePath);
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(readPath);
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      const available = workbook.worksheets.map((ws) => ws.name).join(", ");
      throw new Error(
        `Worksheet "${sheetName}" not found in workbook. Available: ${available}`
      );
    }

    const headers: string[] = [];
    let headerRowIndex = -1;

    // Find first non-empty row as the header row
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (headerRowIndex !== -1) return;
      const cells = row.values as (ExcelJS.CellValue | undefined)[];
      const hasContent = cells.slice(1).some(
        (c) => c !== null && c !== undefined && String(c).trim() !== ""
      );
      if (hasContent) {
        headerRowIndex = rowNumber;
        cells.slice(1).forEach((c) => {
          headers.push(c === null || c === undefined ? "" : String(c).trim());
        });
      }
    });

    if (headers.length === 0) {
      throw new Error(`Worksheet "${sheetName}" appears to be empty.`);
    }

    const dataRows: Array<Record<string, string>> = [];
    let totalDataRows = 0;

    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= headerRowIndex) return;
      totalDataRows++;
      if (dataRows.length < PREVIEW_ROWS) {
        const record: Record<string, string> = {};
        headers.forEach((header, colIdx) => {
          const cell = row.getCell(colIdx + 1);
          record[header] = cellToString(cell);
        });
        dataRows.push(record);
      }
    });

    return {
      headers,
      rowCount: totalDataRows,
      colCount: headers.length,
      previewRows: dataRows,
    };
  } finally {
    if (owned) await fs.unlink(readPath).catch(() => undefined);
  }
}

async function readSheetData(
  filePath: string,
  sheetName: string
): Promise<SheetReadResult> {
  const lower = filePath.toLowerCase();
  // Complex Accenture .xlsm masters often crash ExcelJS on table models
  if (lower.endsWith(".xlsm") || lower.endsWith(".xls")) {
    return readSheetDataWithPython(filePath, sheetName);
  }
  try {
    return await readSheetDataWithExcelJs(filePath, sheetName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Cannot read properties of undefined \(reading 'name'\)/i.test(message)) {
      return readSheetDataWithPython(filePath, sheetName);
    }
    // Retry via Python for other ExcelJS load failures on odd workbooks
    try {
      return await readSheetDataWithPython(filePath, sheetName);
    } catch {
      throw err instanceof Error ? err : new Error(message);
    }
  }
}

// ─── normalize header for fuzzy matching ─────────────────────────────────────

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** New Sheet "Date" is filled with the current system date — not read from ATCI DS. */
export function isGeneratedDateHeader(header: string): boolean {
  return normalizeHeader(header) === "date";
}

/**
 * Build a header-based column mapping (ATCI DS → New Sheet).
 * Destination (New Sheet) order is preserved.
 * Matching is by HEADER NAME only — never by position.
 * "Date" is generated (current system date), not required in ATCI DS.
 * Extra ATCI DS columns are ignored (not added to New Sheet).
 */
export function buildColumnMapping(
  sourceHeaders: string[],
  destinationHeaders: string[]
): ColumnMapping[] | ColumnMappingFailure {
  // Prefer canonical New Sheet order when destination already matches structure.
  const dest =
    destinationHeaders.length === EXPECTED_NEW_SHEET_HEADERS.length &&
    destinationHeaders.every((h, i) =>
      headersMatchIgnoringCase(h, EXPECTED_NEW_SHEET_HEADERS[i])
    )
      ? [...EXPECTED_NEW_SHEET_HEADERS]
      : destinationHeaders;

  const result = buildColumnMappingByHeaderName(sourceHeaders, dest);
  if (!Array.isArray(result)) {
    return {
      ok: false,
      missingDestinationHeaders: result.missingDestinationHeaders,
      availableSourceHeaders: result.availableSourceHeaders,
      message: result.message,
    };
  }
  return result;
}

/** @deprecated Prefer {@link mapAtciDsToNewSheet} — kept for call-site clarity. */
export { mapAtciDsToNewSheet };

function formatSystemDate(): string {
  return formatProcessingDateDDMMYYYY();
}

// ─── public entry point ──────────────────────────────────────────────────────

export async function readLateralDataForPreview(
  setup: LateralDataProcessingSetup
): Promise<DataReadResult> {
  // Download both workbooks to temp in parallel
  const [sourceTempPath, masterTempPath] = await Promise.all([
    downloadToTemp(setup.sourceWorkbook.fileId, setup.sourceWorkbook.fileName),
    downloadToTemp(setup.masterWorkbook.fileId, setup.masterWorkbook.fileName),
  ]);

  try {
    // Read source sheet and master New Sheet in parallel
    const [sourceResult, masterNewSheetResult] = await Promise.all([
      readSheetData(sourceTempPath, setup.sourceWorksheet),
      readSheetData(masterTempPath, setup.masterNewSheet),
    ]);

    // Build column mapping: New Sheet headers → ATCI DS headers (by name)
    const mappingResult = buildColumnMapping(
      sourceResult.headers,
      masterNewSheetResult.headers.length
        ? masterNewSheetResult.headers
        : [...EXPECTED_NEW_SHEET_HEADERS]
    );

    if (!Array.isArray(mappingResult)) {
      // Mapping failed — return failure with details, touch nothing
      return mappingResult;
    }

    // Find source columns that have no counterpart in New Sheet (ignored — not added)
    const mappedSourceHeaders = new Set(
      mappingResult.filter((m) => !m.generated).map((m) => m.sourceHeader)
    );
    const unmatchedSource = sourceResult.headers.filter(
      (h) => h.trim() && !mappedSourceHeaders.has(h)
    );

    // Build preview rows using the mapping (New Sheet column order)
    const today = formatSystemDate();
    const previewMapped = sourceResult.previewRows.map((srcRow) => {
      const destRow: Record<string, string> = {};
      mappingResult.forEach((mapping) => {
        if (mapping.generated || mapping.sourceColIndex < 0) {
          destRow[mapping.destinationHeader] = today;
        } else {
          destRow[mapping.destinationHeader] =
            srcRow[mapping.sourceHeader] ?? "";
        }
      });
      return destRow;
    });

    return {
      ok: true,
      sourceWorkbookName: setup.sourceWorkbook.fileName,
      sourceWorksheetName: setup.sourceWorksheet,
      source: sourceResult,
      masterWorkbookName: setup.masterWorkbook.fileName,
      masterNewSheetName: setup.masterNewSheet,
      masterNewSheetHeaders: masterNewSheetResult.headers,
      columnMappings: mappingResult,
      unmatchedSourceHeaders: unmatchedSource,
      previewMappedRows: previewMapped,
    };
  } finally {
    await Promise.all([
      fs.unlink(sourceTempPath).catch(() => undefined),
      fs.unlink(masterTempPath).catch(() => undefined),
    ]);
  }
}
