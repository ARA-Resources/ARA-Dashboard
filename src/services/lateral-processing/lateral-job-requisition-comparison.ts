/**
 * Job Requisition comparison engine (New Sheet ↔ Master Sheet).
 *
 * Matching key: Job Requisition ID ONLY.
 * - Do not match by row number, Primary Skills, Job Description, or any other field.
 * - Normalize IDs for comparison (trim whitespace) without altering stored JR values.
 * - Detect duplicates in New Sheet and Master Sheet — STOP and report (never pick one silently).
 * - Does NOT change statuses. Status processing is a later step.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import {
  DEFAULT_LATERAL_MASTER_SHEET,
  DEFAULT_LATERAL_NEW_SHEET,
  type LateralDataProcessingSetup,
} from "@/types/lateral-processing-setup";

const execFileAsync = promisify(execFile);

export const JOB_REQUISITION_ID_HEADER = "Job Requisition ID";

export type JobRequisitionSheetLabel = "New Sheet" | "Master Sheet";

export type JobRequisitionComparisonCategory =
  | "only_in_new"
  | "only_in_master"
  | "in_both";

export interface JobRequisitionOccurrence {
  /** Exact stored cell value (not mutated) */
  storedValue: string;
  /** Comparison key after safe normalization */
  normalizedId: string;
  sheet: JobRequisitionSheetLabel;
  /** 1-based Excel row number (for reporting only — never used as a match key) */
  rowNumber: number;
}

export interface DuplicateJobRequisitionGroup {
  normalizedId: string;
  sheet: JobRequisitionSheetLabel;
  occurrences: Array<{ storedValue: string; rowNumber: number }>;
}

export interface JobRequisitionComparisonEntry {
  normalizedId: string;
  /** Representative stored value (New Sheet preferred when present) */
  storedValue: string;
  category: JobRequisitionComparisonCategory;
  newSheetStoredValue: string | null;
  masterSheetStoredValue: string | null;
  newSheetRowNumber: number | null;
  masterSheetRowNumber: number | null;
}

export interface JobRequisitionComparisonSuccess {
  ok: true;
  matchingKey: typeof JOB_REQUISITION_ID_HEADER;
  statusesChanged: false;
  entries: JobRequisitionComparisonEntry[];
  onlyInNew: JobRequisitionComparisonEntry[];
  onlyInMaster: JobRequisitionComparisonEntry[];
  inBoth: JobRequisitionComparisonEntry[];
  newSheetCount: number;
  masterSheetCount: number;
  summaryMessage: string;
}

export interface JobRequisitionComparisonFailure {
  ok: false;
  code: "DUPLICATES" | "MISSING_COLUMN" | "READ_FAILED";
  message: string;
  duplicates: DuplicateJobRequisitionGroup[];
}

export type JobRequisitionComparisonResult =
  | JobRequisitionComparisonSuccess
  | JobRequisitionComparisonFailure;

export class LateralJobRequisitionComparisonError extends Error {
  readonly failure: JobRequisitionComparisonFailure;

  constructor(failure: JobRequisitionComparisonFailure) {
    super(failure.message);
    this.name = "LateralJobRequisitionComparisonError";
    this.failure = failure;
  }
}

/**
 * Safe comparison normalization only.
 * Handles leading/trailing whitespace. Does not rewrite stored workbook values.
 */
export function normalizeJobRequisitionIdForComparison(
  raw: string | null | undefined
): string {
  if (raw === null || raw === undefined) return "";
  return String(raw).trim();
}

export function findJobRequisitionIdColumnIndex(headers: string[]): number {
  return headers.findIndex(
    (h) => (h ?? "").trim() === JOB_REQUISITION_ID_HEADER
  );
}

/**
 * Collect JR occurrences from sheet rows.
 * `dataRows` are 0-based arrays aligned to headers; Excel row numbers start at 2.
 */
export function collectJobRequisitionOccurrences(options: {
  sheet: JobRequisitionSheetLabel;
  headers: string[];
  dataRows: string[][];
  /** Excel row number of the first data row (default 2 = below header) */
  firstDataRowNumber?: number;
}):
  | { ok: true; occurrences: JobRequisitionOccurrence[] }
  | { ok: false; error: string } {
  const col = findJobRequisitionIdColumnIndex(options.headers);
  if (col < 0) {
    return {
      ok: false,
      error: `"${JOB_REQUISITION_ID_HEADER}" column not found in ${options.sheet}.`,
    };
  }

  const firstDataRowNumber = options.firstDataRowNumber ?? 2;
  const occurrences: JobRequisitionOccurrence[] = [];

  options.dataRows.forEach((row, idx) => {
    const storedValue = row[col] ?? "";
    const normalizedId = normalizeJobRequisitionIdForComparison(storedValue);
    if (!normalizedId) return;
    occurrences.push({
      storedValue,
      normalizedId,
      sheet: options.sheet,
      rowNumber: firstDataRowNumber + idx,
    });
  });

  return { ok: true, occurrences };
}

export function findDuplicateJobRequisitions(
  occurrences: JobRequisitionOccurrence[]
): DuplicateJobRequisitionGroup[] {
  const byKey = new Map<string, JobRequisitionOccurrence[]>();
  for (const occ of occurrences) {
    const list = byKey.get(occ.normalizedId) ?? [];
    list.push(occ);
    byKey.set(occ.normalizedId, list);
  }

  const duplicates: DuplicateJobRequisitionGroup[] = [];
  for (const [normalizedId, list] of byKey) {
    if (list.length < 2) continue;
    duplicates.push({
      normalizedId,
      sheet: list[0].sheet,
      occurrences: list.map((o) => ({
        storedValue: o.storedValue,
        rowNumber: o.rowNumber,
      })),
    });
  }

  return duplicates.sort((a, b) =>
    a.normalizedId.localeCompare(b.normalizedId)
  );
}

export function formatDuplicateJobRequisitionMessage(
  duplicates: DuplicateJobRequisitionGroup[]
): string {
  const lines = [
    "Duplicate Job Requisition IDs detected. Comparison stopped.",
    "Do not silently choose one duplicate. Fix the workbook and re-run.",
    `Matching key: ${JOB_REQUISITION_ID_HEADER} only (not row number / Primary Skills / Job Description).`,
  ];
  for (const group of duplicates) {
    const locs = group.occurrences
      .map((o) => `row ${o.rowNumber} (stored "${o.storedValue}")`)
      .join("; ");
    lines.push(
      `  ${group.sheet}: "${group.normalizedId}" appears ${group.occurrences.length} times — ${locs}`
    );
  }
  return lines.join("\n");
}

/**
 * Build New Sheet ↔ Master Sheet comparison by Job Requisition ID only.
 * Does not change statuses.
 */
export function compareJobRequisitionsById(options: {
  newSheetOccurrences: JobRequisitionOccurrence[];
  masterSheetOccurrences: JobRequisitionOccurrence[];
}): JobRequisitionComparisonResult {
  const newDupes = findDuplicateJobRequisitions(options.newSheetOccurrences);
  const masterDupes = findDuplicateJobRequisitions(
    options.masterSheetOccurrences
  );
  const duplicates = [...newDupes, ...masterDupes];
  if (duplicates.length > 0) {
    return {
      ok: false,
      code: "DUPLICATES",
      message: formatDuplicateJobRequisitionMessage(duplicates),
      duplicates,
    };
  }

  const newById = new Map<string, JobRequisitionOccurrence>();
  for (const occ of options.newSheetOccurrences) {
    newById.set(occ.normalizedId, occ);
  }
  const masterById = new Map<string, JobRequisitionOccurrence>();
  for (const occ of options.masterSheetOccurrences) {
    masterById.set(occ.normalizedId, occ);
  }

  const allIds = new Set([...newById.keys(), ...masterById.keys()]);
  const entries: JobRequisitionComparisonEntry[] = [];

  for (const normalizedId of [...allIds].sort((a, b) => a.localeCompare(b))) {
    const neu = newById.get(normalizedId) ?? null;
    const master = masterById.get(normalizedId) ?? null;
    let category: JobRequisitionComparisonCategory;
    if (neu && master) category = "in_both";
    else if (neu) category = "only_in_new";
    else category = "only_in_master";

    entries.push({
      normalizedId,
      storedValue: neu?.storedValue ?? master?.storedValue ?? normalizedId,
      category,
      newSheetStoredValue: neu?.storedValue ?? null,
      masterSheetStoredValue: master?.storedValue ?? null,
      newSheetRowNumber: neu?.rowNumber ?? null,
      masterSheetRowNumber: master?.rowNumber ?? null,
    });
  }

  const onlyInNew = entries.filter((e) => e.category === "only_in_new");
  const onlyInMaster = entries.filter((e) => e.category === "only_in_master");
  const inBoth = entries.filter((e) => e.category === "in_both");

  return {
    ok: true,
    matchingKey: JOB_REQUISITION_ID_HEADER,
    statusesChanged: false,
    entries,
    onlyInNew,
    onlyInMaster,
    inBoth,
    newSheetCount: newById.size,
    masterSheetCount: masterById.size,
    summaryMessage: `Compared Job Requisition IDs only (no status changes): New Sheet=${newById.size}, Master Sheet=${masterById.size}, only-in-New=${onlyInNew.length}, only-in-Master=${onlyInMaster.length}, in-both=${inBoth.length}.`,
  };
}

async function downloadMasterToTemp(
  fileId: string,
  fileName: string
): Promise<string> {
  const { drive } = await getAuthorizedGmailClient();
  const safe = (fileName || fileId).replace(/[^\w.-]+/g, "_");
  const tempPath = path.join(
    os.tmpdir(),
    `lateral-jr-compare-${Date.now()}-${safe}`
  );
  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(tempPath, Buffer.from(response.data as ArrayBuffer));
  return tempPath;
}

async function readSheetRowsWithPython(
  filePath: string,
  sheetName: string
): Promise<{ headers: string[]; dataRows: string[][]; headerRowNumber: number }> {
  const scriptPath = path.join(
    os.tmpdir(),
    `lateral-jr-read-${Date.now()}-${Math.random().toString(16).slice(2)}.py`
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
    # Preserve stored JR text; only coerce None → ""
    values = [("" if c is None else str(c)) for c in row]
    if header_row_idx is None:
        if any(str(v).strip() for v in values):
            headers = [str(v).strip() for v in values]
            while headers and not headers[-1]:
                headers.pop()
            header_row_idx = i
        continue
    if not any(str(v).strip() for v in values):
        continue
    row_vals = []
    for idx in range(len(headers)):
        row_vals.append(values[idx] if idx < len(values) else "")
    data_rows.append(row_vals)
wb.close()
if header_row_idx is None or not headers:
    print(json.dumps({"ok": False, "error": 'Worksheet "%s" appears to be empty.' % sheet_name}))
else:
    print(json.dumps({"ok": True, "headers": headers, "dataRows": data_rows, "headerRowNumber": header_row_idx}))
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
      | {
          ok: true;
          headers: string[];
          dataRows: string[][];
          headerRowNumber: number;
        }
      | { ok: false; error: string };
    if (!parsed.ok) throw new Error(parsed.error);
    return {
      headers: parsed.headers,
      dataRows: parsed.dataRows,
      headerRowNumber: parsed.headerRowNumber,
    };
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

/**
 * Compare from a local Master Workbook path (read-only, no status changes).
 */
export async function compareJobRequisitionsFromLocalMaster(options: {
  localPath: string;
  masterSheetName?: string;
  newSheetName?: string;
}): Promise<JobRequisitionComparisonResult> {
  const masterSheet =
    options.masterSheetName?.trim() || DEFAULT_LATERAL_MASTER_SHEET;
  const newSheet = options.newSheetName?.trim() || DEFAULT_LATERAL_NEW_SHEET;

  try {
    const [newRead, masterRead] = await Promise.all([
      readSheetRowsWithPython(options.localPath, newSheet),
      readSheetRowsWithPython(options.localPath, masterSheet),
    ]);

    const newCollected = collectJobRequisitionOccurrences({
      sheet: "New Sheet",
      headers: newRead.headers,
      dataRows: newRead.dataRows,
      firstDataRowNumber: newRead.headerRowNumber + 1,
    });
    if (!newCollected.ok) {
      return {
        ok: false,
        code: "MISSING_COLUMN",
        message: newCollected.error,
        duplicates: [],
      };
    }

    const masterCollected = collectJobRequisitionOccurrences({
      sheet: "Master Sheet",
      headers: masterRead.headers,
      dataRows: masterRead.dataRows,
      firstDataRowNumber: masterRead.headerRowNumber + 1,
    });
    if (!masterCollected.ok) {
      return {
        ok: false,
        code: "MISSING_COLUMN",
        message: masterCollected.error,
        duplicates: [],
      };
    }

    return compareJobRequisitionsById({
      newSheetOccurrences: newCollected.occurrences,
      masterSheetOccurrences: masterCollected.occurrences,
    });
  } catch (error) {
    return {
      ok: false,
      code: "READ_FAILED",
      message:
        error instanceof Error
          ? `Failed to read sheets for JR comparison: ${error.message}`
          : "Failed to read sheets for JR comparison.",
      duplicates: [],
    };
  }
}

/**
 * Compare New Sheet vs Master Sheet Job Requisition IDs from the Master Workbook on Drive.
 * Read-only — does not change statuses or rewrite JR values.
 */
export async function compareJobRequisitionsFromMasterWorkbook(options: {
  setup: LateralDataProcessingSetup;
}): Promise<JobRequisitionComparisonResult> {
  const setup = options.setup;
  const masterSheet =
    setup.masterSheet?.trim() || DEFAULT_LATERAL_MASTER_SHEET;
  const newSheet = setup.masterNewSheet?.trim() || DEFAULT_LATERAL_NEW_SHEET;

  let tempPath: string;
  try {
    tempPath = await downloadMasterToTemp(
      setup.masterWorkbook.fileId,
      setup.masterWorkbook.fileName
    );
  } catch (error) {
    return {
      ok: false,
      code: "READ_FAILED",
      message:
        error instanceof Error
          ? `Failed to download Master Workbook for JR comparison: ${error.message}`
          : "Failed to download Master Workbook for JR comparison.",
      duplicates: [],
    };
  }

  try {
    return await compareJobRequisitionsFromLocalMaster({
      localPath: tempPath,
      masterSheetName: masterSheet,
      newSheetName: newSheet,
    });
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
}
