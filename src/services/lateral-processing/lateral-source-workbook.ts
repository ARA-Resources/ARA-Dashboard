/**
 * Lateral source workbook processing (read-only).
 *
 * After a successful Drive upload:
 * - Open the uploaded workbook
 * - Find worksheet by EXACT name (default: "ATCI DS") — never assume first sheet
 * - Read header row, data rows, row/column counts
 * - Never modify the source workbook
 *
 * If the worksheet is missing: STOP with
 *   "ATCI DS worksheet was not found."
 * Caller must not advance Gmail checkpoint or modify the Master Workbook.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import { DEFAULT_LATERAL_SOURCE_WORKSHEET } from "@/types/lateral-processing-setup";

const execFileAsync = promisify(execFile);

/** Canonical failure message when the Lateral source sheet is missing. */
export const ATCI_DS_WORKSHEET_NOT_FOUND = "ATCI DS worksheet was not found.";

export class LateralSourceWorkbookError extends Error {
  readonly code: "WORKSHEET_NOT_FOUND" | "READ_FAILED" | "EMPTY_SHEET";

  constructor(
    code: LateralSourceWorkbookError["code"],
    message: string,
    readonly availableWorksheets: string[] = [],
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "LateralSourceWorkbookError";
    this.code = code;
  }
}

export interface LateralSourceWorkbookRead {
  workbookPath: string;
  workbookFileName: string;
  /** Exact worksheet name that was opened */
  worksheetName: string;
  /** All worksheet names in the workbook (for logging) */
  availableWorksheets: string[];
  /** Header row values (trimmed); trailing empty headers removed */
  headers: string[];
  /** Data rows as string cells aligned to headers */
  dataRows: string[][];
  /** Number of non-empty data rows (excludes header) */
  rowCount: number;
  /** Number of columns (header width) */
  colCount: number;
  /** 1-based Excel row index of the header */
  headerRowNumber: number;
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

/**
 * Exact worksheet lookup — never falls back to the first sheet.
 */
export function findWorksheetByExactName(
  worksheetNames: string[],
  exactName: string
): string | null {
  const target = exactName.trim();
  if (!target) return null;
  return worksheetNames.includes(target) ? target : null;
}

export function sourceWorksheetNotFoundMessage(worksheetName: string): string {
  if (worksheetName.trim() === DEFAULT_LATERAL_SOURCE_WORKSHEET) {
    return ATCI_DS_WORKSHEET_NOT_FOUND;
  }
  return `"${worksheetName.trim()}" worksheet was not found.`;
}

async function listWorksheetNamesWithExcelJs(
  filePath: string
): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook.worksheets.map((ws) => ws.name);
}

async function listWorksheetNamesWithPython(
  filePath: string
): Promise<string[]> {
  const script = [
    "import json,sys",
    "from openpyxl import load_workbook",
    "wb=load_workbook(sys.argv[1], read_only=True, data_only=True, keep_vba=True)",
    "print(json.dumps(list(wb.sheetnames)))",
    "wb.close()",
  ].join(";");
  const result = await execFileAsync("python", ["-c", script, filePath], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse((result.stdout || "").trim()) as string[];
}

export async function listSourceWorkbookWorksheets(
  filePath: string
): Promise<string[]> {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".xlsm") || lower.endsWith(".xls")) {
    return listWorksheetNamesWithPython(filePath);
  }
  try {
    return await listWorksheetNamesWithExcelJs(filePath);
  } catch {
    return listWorksheetNamesWithPython(filePath);
  }
}

async function readSourceSheetWithPython(
  filePath: string,
  sheetName: string
): Promise<{
  headers: string[];
  dataRows: string[][];
  headerRowNumber: number;
}> {
  const scriptPath = path.join(
    os.tmpdir(),
    `lateral-source-read-${Date.now()}-${Math.random().toString(16).slice(2)}.py`
  );
  const script = `
import json, sys
from openpyxl import load_workbook

path, sheet_name = sys.argv[1], sys.argv[2]
wb = load_workbook(path, read_only=True, data_only=True, keep_vba=True)
names = list(wb.sheetnames)
if sheet_name not in names:
    print(json.dumps({"ok": False, "error": "NOT_FOUND", "available": names}))
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
    trimmed = values[:len(headers)]
    while len(trimmed) < len(headers):
        trimmed.append("")
    data_rows.append(trimmed)
wb.close()
if header_row_idx is None or not headers:
    print(json.dumps({"ok": False, "error": "EMPTY", "available": names}))
else:
    print(json.dumps({
        "ok": True,
        "headers": headers,
        "dataRows": data_rows,
        "headerRowNumber": header_row_idx,
        "available": names,
    }))
`.trim();

  await fs.writeFile(scriptPath, script, "utf8");
  try {
    const result = await execFileAsync("python", [scriptPath, filePath, sheetName], {
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const parsed = JSON.parse((result.stdout || "").trim()) as
      | {
          ok: true;
          headers: string[];
          dataRows: string[][];
          headerRowNumber: number;
          available: string[];
        }
      | { ok: false; error: string; available?: string[] };

    if (!parsed.ok) {
      if (parsed.error === "NOT_FOUND") {
        throw new LateralSourceWorkbookError(
          "WORKSHEET_NOT_FOUND",
          sourceWorksheetNotFoundMessage(sheetName),
          parsed.available ?? []
        );
      }
      throw new LateralSourceWorkbookError(
        "EMPTY_SHEET",
        `Worksheet "${sheetName}" appears to be empty.`,
        parsed.available ?? []
      );
    }
    return {
      headers: parsed.headers,
      dataRows: parsed.dataRows,
      headerRowNumber: parsed.headerRowNumber,
    };
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

async function readSourceSheetWithExcelJs(
  filePath: string,
  sheetName: string
): Promise<{
  headers: string[];
  dataRows: string[][];
  headerRowNumber: number;
  available: string[];
}> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const available = workbook.worksheets.map((ws) => ws.name);

  // Exact name only — ExcelJS getWorksheet is exact; do not fall back to index 0.
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    throw new LateralSourceWorkbookError(
      "WORKSHEET_NOT_FOUND",
      sourceWorksheetNotFoundMessage(sheetName),
      available
    );
  }

  const headers: string[] = [];
  let headerRowNumber = -1;

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (headerRowNumber !== -1) return;
    const cells = row.values as (ExcelJS.CellValue | undefined)[];
    const hasContent = cells
      .slice(1)
      .some((c) => c !== null && c !== undefined && String(c).trim() !== "");
    if (!hasContent) return;
    headerRowNumber = rowNumber;
    cells.slice(1).forEach((c) => {
      headers.push(c === null || c === undefined ? "" : String(c).trim());
    });
    while (headers.length > 0 && !headers[headers.length - 1]) {
      headers.pop();
    }
  });

  if (headerRowNumber === -1 || headers.length === 0) {
    throw new LateralSourceWorkbookError(
      "EMPTY_SHEET",
      `Worksheet "${sheetName}" appears to be empty.`,
      available
    );
  }

  const dataRows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    const values: string[] = [];
    let any = false;
    for (let col = 1; col <= headers.length; col += 1) {
      const text = cellToString(row.getCell(col)).trim();
      if (text) any = true;
      values.push(text);
    }
    if (!any) return;
    dataRows.push(values);
  });

  return { headers, dataRows, headerRowNumber, available };
}

/**
 * Open the uploaded Lateral source workbook and read the configured source
 * worksheet (default "ATCI DS") by exact name. Read-only — never writes back.
 */
export async function processLateralSourceWorkbook(options: {
  localPath: string;
  /** Exact worksheet name; defaults to "ATCI DS" */
  worksheetName?: string;
  workbookFileName?: string;
}): Promise<LateralSourceWorkbookRead> {
  const worksheetName = (
    options.worksheetName?.trim() || DEFAULT_LATERAL_SOURCE_WORKSHEET
  ).trim();
  const workbookFileName =
    options.workbookFileName?.trim() || path.basename(options.localPath);

  let availableWorksheets: string[];
  try {
    availableWorksheets = await listSourceWorkbookWorksheets(options.localPath);
  } catch (error) {
    throw new LateralSourceWorkbookError(
      "READ_FAILED",
      error instanceof Error
        ? `Failed to open source workbook: ${error.message}`
        : "Failed to open source workbook.",
      [],
      error
    );
  }

  const exact = findWorksheetByExactName(availableWorksheets, worksheetName);
  if (!exact) {
    throw new LateralSourceWorkbookError(
      "WORKSHEET_NOT_FOUND",
      sourceWorksheetNotFoundMessage(worksheetName),
      availableWorksheets
    );
  }

  const lower = options.localPath.toLowerCase();
  try {
    if (lower.endsWith(".xlsm") || lower.endsWith(".xls")) {
      const read = await readSourceSheetWithPython(options.localPath, exact);
      return {
        workbookPath: options.localPath,
        workbookFileName,
        worksheetName: exact,
        availableWorksheets,
        headers: read.headers,
        dataRows: read.dataRows,
        rowCount: read.dataRows.length,
        colCount: read.headers.length,
        headerRowNumber: read.headerRowNumber,
      };
    }

    try {
      const read = await readSourceSheetWithExcelJs(options.localPath, exact);
      return {
        workbookPath: options.localPath,
        workbookFileName,
        worksheetName: exact,
        availableWorksheets: read.available,
        headers: read.headers,
        dataRows: read.dataRows,
        rowCount: read.dataRows.length,
        colCount: read.headers.length,
        headerRowNumber: read.headerRowNumber,
      };
    } catch (err) {
      if (err instanceof LateralSourceWorkbookError) throw err;
      const read = await readSourceSheetWithPython(options.localPath, exact);
      return {
        workbookPath: options.localPath,
        workbookFileName,
        worksheetName: exact,
        availableWorksheets,
        headers: read.headers,
        dataRows: read.dataRows,
        rowCount: read.dataRows.length,
        colCount: read.headers.length,
        headerRowNumber: read.headerRowNumber,
      };
    }
  } catch (error) {
    if (error instanceof LateralSourceWorkbookError) throw error;
    throw new LateralSourceWorkbookError(
      "READ_FAILED",
      error instanceof Error
        ? `Failed to read source worksheet "${exact}": ${error.message}`
        : `Failed to read source worksheet "${exact}".`,
      availableWorksheets,
      error
    );
  }
}
