/**
 * Lateral New Sheet structure validation.
 *
 * Destination source of truth — Row 1 headers must match in order A–J:
 *   A Date
 *   B Job Requisition ID
 *   C Priority
 *   D Job Description
 *   E Skill Categorization
 *   F Primary Skills
 *   G Job Management Level
 *   H Primary Location/Office Locate
 *   I Market Map
 *   J POC
 *
 * Comparison is case-insensitive (e.g. "locate" vs "Locate") but order and
 * wording must still match. On mismatch: STOP. Do not rearrange columns.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import { DEFAULT_LATERAL_NEW_SHEET } from "@/types/lateral-processing-setup";

const execFileAsync = promisify(execFile);

/** Canonical New Sheet header sequence (columns A–J). Order is the source of truth. */
export const EXPECTED_NEW_SHEET_HEADERS = [
  "Date",
  "Job Requisition ID",
  "Priority",
  "Job Description",
  "Skill Categorization",
  "Primary Skills",
  "Job Management Level",
  "Primary Location/Office Locate",
  "Market Map",
  "POC",
] as const;

export type ExpectedNewSheetHeader = (typeof EXPECTED_NEW_SHEET_HEADERS)[number];

export interface NewSheetHeaderDifference {
  /** Excel column letter (A–J, or beyond) */
  column: string;
  /** 0-based index */
  index: number;
  expected: string;
  actual: string;
}

export interface NewSheetStructureValidation {
  ok: boolean;
  expectedHeaders: readonly string[];
  actualHeaders: string[];
  differences: NewSheetHeaderDifference[];
  /** Human-readable summary listing every differing header */
  message: string;
}

export class LateralNewSheetStructureError extends Error {
  readonly code = "HEADER_MISMATCH" as const;
  readonly validation: NewSheetStructureValidation;

  constructor(validation: NewSheetStructureValidation) {
    super(validation.message);
    this.name = "LateralNewSheetStructureError";
    this.validation = validation;
  }
}

export function columnLetterFromIndex(index: number): string {
  if (index < 0) return "?";
  let n = index;
  let letter = "";
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

/** Normalize for New Sheet header compare: trim + case-insensitive. */
export function normalizeNewSheetHeaderForCompare(value: string): string {
  return (value ?? "").trim().toLowerCase();
}

export function headersMatchIgnoringCase(
  expected: string,
  actual: string
): boolean {
  return (
    normalizeNewSheetHeaderForCompare(expected) ===
    normalizeNewSheetHeaderForCompare(actual)
  );
}

/**
 * Compare actual Row 1 headers to the expected A–J sequence.
 * Order must match; casing may differ (e.g. Locate vs locate).
 */
export function validateNewSheetHeaderStructure(
  actualHeaders: string[]
): NewSheetStructureValidation {
  const expectedHeaders = [...EXPECTED_NEW_SHEET_HEADERS];
  const actual = actualHeaders.map((h) => (h ?? "").trim());

  // Compare through max length so extra/missing columns are reported.
  const maxLen = Math.max(expectedHeaders.length, actual.length);
  const differences: NewSheetHeaderDifference[] = [];

  for (let i = 0; i < maxLen; i += 1) {
    const expected = expectedHeaders[i] ?? "";
    const got = actual[i] ?? "";
    if (!headersMatchIgnoringCase(expected, got)) {
      differences.push({
        column: columnLetterFromIndex(i),
        index: i,
        expected: expected || "(none)",
        actual: got || "(empty)",
      });
    }
  }

  const ok = differences.length === 0;
  const message = ok
    ? "New Sheet Row 1 headers match the expected A–J structure."
    : [
        "New Sheet headers do not match the expected structure. Pipeline stopped. Columns were not rearranged and no data was deleted.",
        "Differences:",
        ...differences.map(
          (d) =>
            `  ${d.column}: expected "${d.expected}", actual "${d.actual}"`
        ),
        `Expected order: ${expectedHeaders.join(" | ")}`,
        `Actual Row 1:   ${actual.length ? actual.join(" | ") : "(empty)"}`,
      ].join("\n");

  return {
    ok,
    expectedHeaders,
    actualHeaders: actual,
    differences,
    message,
  };
}

function cellToString(value: ExcelJS.CellValue | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "richText" in value) {
    return (value as ExcelJS.CellRichTextValue).richText
      .map((chunk) => chunk?.text ?? "")
      .join("");
  }
  if (typeof value === "object" && "result" in value) {
    const r = (value as ExcelJS.CellFormulaValue).result;
    return r === null || r === undefined ? "" : String(r);
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/** Read Row 1 headers only (exact first worksheet row — not first non-empty). */
export async function readNewSheetRow1HeadersFromLocal(
  filePath: string,
  sheetName: string = DEFAULT_LATERAL_NEW_SHEET
): Promise<string[]> {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".xlsm") || lower.endsWith(".xls")) {
    return readRow1WithPython(filePath, sheetName);
  }
  try {
    return await readRow1WithExcelJs(filePath, sheetName);
  } catch {
    return readRow1WithPython(filePath, sheetName);
  }
}

async function readRow1WithExcelJs(
  filePath: string,
  sheetName: string
): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    throw new Error(`Worksheet "${sheetName}" not found.`);
  }
  const row = sheet.getRow(1);
  const values: string[] = [];
  const maxCol = Math.max(row.cellCount, EXPECTED_NEW_SHEET_HEADERS.length);
  for (let col = 1; col <= maxCol; col += 1) {
    values.push(cellToString(row.getCell(col).value).trim());
  }
  while (values.length > 0 && !values[values.length - 1]) {
    values.pop();
  }
  return values;
}

async function readRow1WithPython(
  filePath: string,
  sheetName: string
): Promise<string[]> {
  const scriptPath = path.join(
    os.tmpdir(),
    `lateral-new-sheet-row1-${Date.now()}-${Math.random().toString(16).slice(2)}.py`
  );
  const script = `
import json, sys
from openpyxl import load_workbook

path, sheet_name, min_cols = sys.argv[1], sys.argv[2], int(sys.argv[3])
wb = load_workbook(path, read_only=True, data_only=True, keep_vba=True)
if sheet_name not in wb.sheetnames:
    print(json.dumps({"ok": False, "error": 'Worksheet "%s" not found. Available: %s' % (sheet_name, ", ".join(wb.sheetnames))}))
    wb.close()
    raise SystemExit(0)
ws = wb[sheet_name]
row = next(ws.iter_rows(min_row=1, max_row=1, values_only=True), None)
wb.close()
if row is None:
    print(json.dumps({"ok": True, "headers": []}))
    raise SystemExit(0)
values = [("" if c is None else str(c).strip()) for c in row]
while len(values) < min_cols:
    values.append("")
while values and not values[-1]:
    values.pop()
print(json.dumps({"ok": True, "headers": values}))
`.trim();

  await fs.writeFile(scriptPath, script, "utf8");
  try {
    const result = await execFileAsync(
      "python",
      [scriptPath, filePath, sheetName, String(EXPECTED_NEW_SHEET_HEADERS.length)],
      {
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      }
    );
    const parsed = JSON.parse((result.stdout || "").trim()) as
      | { ok: true; headers: string[] }
      | { ok: false; error: string };
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    return parsed.headers;
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

async function downloadMasterToTemp(
  fileId: string,
  fileName: string
): Promise<string> {
  const { drive } = await getAuthorizedGmailClient();
  const safe = (fileName || fileId).replace(/[^\w.-]+/g, "_");
  const tempPath = path.join(
    os.tmpdir(),
    `lateral-new-sheet-struct-${Date.now()}-${safe}`
  );
  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(tempPath, Buffer.from(response.data as ArrayBuffer));
  return tempPath;
}

/**
 * Validate New Sheet Row 1 structure from the Master Workbook on Drive.
 * Read-only — never rearranges columns or deletes data.
 */
export async function validateNewSheetStructureFromDrive(options: {
  masterFileId: string;
  masterFileName: string;
  newSheetName?: string;
}): Promise<NewSheetStructureValidation> {
  const sheetName = options.newSheetName?.trim() || DEFAULT_LATERAL_NEW_SHEET;
  const tempPath = await downloadMasterToTemp(
    options.masterFileId,
    options.masterFileName
  );
  try {
    const actualHeaders = await readNewSheetRow1HeadersFromLocal(
      tempPath,
      sheetName
    );
    return validateNewSheetHeaderStructure(actualHeaders);
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
}

/**
 * Validate and throw LateralNewSheetStructureError when headers differ.
 */
export async function assertNewSheetStructureFromDrive(options: {
  masterFileId: string;
  masterFileName: string;
  newSheetName?: string;
}): Promise<NewSheetStructureValidation> {
  const validation = await validateNewSheetStructureFromDrive(options);
  if (!validation.ok) {
    throw new LateralNewSheetStructureError(validation);
  }
  return validation;
}
