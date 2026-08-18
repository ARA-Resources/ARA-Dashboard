/**
 * Posted Sheet A/B/C + Master Sheet Column M matching.
 *
 * Reproduces FilterAndMatchJobsPosted (Module2):
 *   A = cleaned posting text (not JR-only)
 *   B = Job Requisition ID (extracted from A)
 *   C = Demand Yes/No (Posted B matched to Master Job Requisition ID)
 *   Master Column M = Posted Yes / -
 *   Job Status / Column K is never written
 *
 * Runs on the staged local XLSM after Column K reconciliation and before
 * confirmReconciliationSave(). Failure does not save Column M / B / C changes.
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_LATERAL_MASTER_SHEET,
} from "@/types/lateral-processing-setup";
import {
  JOB_REQUISITION_ID_HEADER,
  MASTER_JOB_STATUS_COLUMN_K,
} from "@/services/lateral-processing/lateral-job-status-rules";

const execFileAsync = promisify(execFile);

export const POSTED_SHEET_NAME = "Posted Sheet";
export const MASTER_POSTED_HEADER = "Posted";
export const POSTED_JR_HEADER = "Job Requisition ID";
export const POSTED_DEMAND_HEADER = "Demand";
/** Excel column M (1-based). Posted values are written only here. */
export const MASTER_POSTED_COLUMN_M = 13;

export interface PostedMatchingCounts {
  postedSheetRowsRead: number;
  validAtciRows: number;
  removedNonAtciRows: number;
  uniquePostedJrIds: number;
  matchingJrs: number;
  nonMatchingPostedJrs: number;
  demandYesCount: number;
  demandNoCount: number;
  masterRowsMarkedYes: number;
  masterRowsResetToDash: number;
  columnKUnchanged: true;
}

export interface PostedMatchingSuccess {
  ok: true;
  counts: PostedMatchingCounts;
  postedSheet: typeof POSTED_SHEET_NAME;
  masterSheet: string;
  postedColumn: "M";
  postedColumnIndex: typeof MASTER_POSTED_COLUMN_M;
  postedSheetColumns: { a: "posting"; b: "Job Requisition ID"; c: "Demand" };
  helperColumnsWritten: true;
}

export interface PostedMatchingFailure {
  ok: false;
  error: string;
  /** True when the staged workbook was not saved (Column M / Column K untouched). */
  workbookUnchanged: true;
  columnKModified: false;
}

export type PostedMatchingResult = PostedMatchingSuccess | PostedMatchingFailure;

/**
 * VBA-equivalent JR extraction from Posted Sheet Column A.
 * Trim, then take text before the first space or `|` separator.
 */
export function extractPostedJobRequisitionId(columnA: string): string {
  const trimmed = (columnA || "").trim();
  if (!trimmed) return "";
  const separatorIndex = trimmed.search(/[ |]/);
  if (separatorIndex < 0) return trimmed;
  return trimmed.slice(0, separatorIndex).trim();
}

/**
 * Collapse messy source whitespace/newlines into the readable Posted format:
 *   ATCI-5698629-S2063571 | Posting Date: 08/13/2026 | Pune
 */
export function cleanPostedColumnAValue(columnA: unknown): string {
  if (columnA == null) return "";
  const raw = String(columnA)
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\n/g, " ");
  const collapsed = raw.split(/\s+/).join(" ").trim();
  if (!collapsed) return "";
  return collapsed
    .split("|")
    .map((part) => part.trim())
    .join(" | ");
}

function buildPostedMatchingPythonScript(): string {
  return `
import json
import os
import sys

from openpyxl import load_workbook

workbook_path = sys.argv[1]
output_path = sys.argv[2]
master_sheet_name = sys.argv[3]
posted_sheet_name = sys.argv[4]
jr_header = sys.argv[5]
posted_header = sys.argv[6]
posted_col_m = int(sys.argv[7])
status_col_k = int(sys.argv[8])

def fail(message):
    print(json.dumps({
        "ok": False,
        "error": message,
        "workbookUnchanged": True,
        "columnKModified": False,
    }))
    sys.exit(0)

def cell_text(value):
    if value is None:
        return ""
    return str(value).strip()

def last_used_row_col_a(ws):
    max_r = ws.max_row or 1
    for r in range(max_r, 1, -1):
        if cell_text(ws.cell(r, 1).value):
            return r
    return 1

def clean_posted_text(value):
    if value is None:
        return ""
    s = str(value).replace("\\u00a0", " ")
    s = s.replace("\\r\\n", "\\n").replace("\\r", "\\n").replace("\\t", " ")
    s = s.replace("\\n", " ")
    s = " ".join(s.split()).strip()
    if not s:
        return ""
    return " | ".join(part.strip() for part in s.split("|"))

def extract_jr_id(cleaned):
    s = (cleaned or "").strip()
    if not s:
        return ""
    for i, ch in enumerate(s):
        if ch in (" ", "|"):
            return s[:i].strip()
    return s

def header_index(ws, wanted):
    target = wanted.strip().lower()
    max_c = ws.max_column or 1
    for c in range(1, max_c + 1):
        if cell_text(ws.cell(1, c).value).lower() == target:
            return c
    return None

if not os.path.isfile(workbook_path):
    fail("Staged Master Workbook was not found for Posted matching.")

try:
    wb = load_workbook(workbook_path, keep_vba=True, data_only=False)
except Exception as e:
    fail(f"Posted Sheet / Master Sheet could not be opened: {e}")

try:
    if master_sheet_name not in wb.sheetnames:
        fail(f'Master Sheet "{master_sheet_name}" was not found. Posted matching stopped; Column M was not changed.')
    if posted_sheet_name not in wb.sheetnames:
        fail(f'Posted Sheet was not found. Posted matching stopped; Column M was not changed.')

    ws_master = wb[master_sheet_name]
    ws_posted = wb[posted_sheet_name]

    jr_col = header_index(ws_master, jr_header)
    posted_col = header_index(ws_master, posted_header)

    if jr_col is None:
        fail("Master Sheet header 'Job Requisition ID' was not found. Posted matching stopped; Column M was not changed.")
    if posted_col is None:
        fail("Master Sheet header 'Posted' was not found. Posted matching stopped; Column M was not changed.")
    if posted_col != posted_col_m:
        fail(
            f"Master Sheet 'Posted' header is in column {posted_col}, expected Column M ({posted_col_m}). "
            "Posted matching stopped; Column M was not changed."
        )
    posted_m_header = cell_text(ws_master.cell(1, posted_col_m).value)
    if posted_m_header.lower() != posted_header.strip().lower():
        fail(
            f"Master Sheet Column M header is '{posted_m_header or '(blank)'}', expected 'Posted'. "
            "Posted matching stopped; Column M was not changed."
        )

    last_posted = last_used_row_col_a(ws_posted)
    last_master = last_used_row_col_a(ws_master)

    # Snapshot Column K BEFORE any writes — must remain identical after save.
    k_before = [
        ws_master.cell(r, status_col_k).value
        for r in range(1, last_master + 1)
    ]
    master_row_count_before = last_master

    posted_rows_read = max(0, last_posted - 1)
    cleaned_rows = []
    removed_non_atci = 0
    for r in range(2, last_posted + 1):
        original = ws_posted.cell(r, 1).value
        cleaned = clean_posted_text(original)
        if not cleaned.startswith("ATCI"):
            removed_non_atci += 1
            continue
        jr = extract_jr_id(cleaned)
        cleaned_rows.append((cleaned, jr))

    master_jr_set = set()
    for r in range(2, last_master + 1):
        jr = cell_text(ws_master.cell(r, jr_col).value)
        if jr:
            master_jr_set.add(jr)

    posted_id_set = set()
    demand_yes = 0
    demand_no = 0
    for cleaned, jr in cleaned_rows:
        if jr:
            posted_id_set.add(jr)

    # Rewrite Posted Sheet: A = posting text, B = JR, C = Demand. Keep all ATCI rows (including duplicate JRs).
    max_clear = max(ws_posted.max_row or 1, last_posted)
    if max_clear > 1:
        ws_posted.delete_rows(2, max_clear - 1)
    # Do not overwrite Column A header. VBA sets B/C headers explicitly.
    ws_posted.cell(1, 2).value = "Job Requisition ID"
    ws_posted.cell(1, 3).value = "Demand"
    for i, (cleaned, jr) in enumerate(cleaned_rows, start=2):
        demand = "Yes" if jr and jr in master_jr_set else "No"
        if demand == "Yes":
            demand_yes += 1
        else:
            demand_no += 1
        ws_posted.cell(i, 1).value = cleaned
        ws_posted.cell(i, 2).value = jr
        ws_posted.cell(i, 3).value = demand

    # Reset Column M to "-" then mark matches Yes. Never write Column K.
    master_yes = 0
    master_dash = 0
    matching_master_jrs = set()
    for r in range(2, last_master + 1):
        jr = cell_text(ws_master.cell(r, jr_col).value)
        if jr and jr in posted_id_set:
            ws_master.cell(r, posted_col_m).value = "Yes"
            master_yes += 1
            matching_master_jrs.add(jr)
        else:
            ws_master.cell(r, posted_col_m).value = "-"
            master_dash += 1

    matching_jrs = len(matching_master_jrs)
    non_matching_posted_jrs = len(posted_id_set - matching_master_jrs)

    k_after = [
        ws_master.cell(r, status_col_k).value
        for r in range(1, last_master + 1)
    ]
    if k_before != k_after:
        fail("Posted matching aborted: Master Sheet Column K / Job Status would have changed.")
    if last_used_row_col_a(ws_master) != master_row_count_before:
        fail("Posted matching aborted: Master Sheet row count changed. No rows may be added or deleted.")

    parent = os.path.dirname(output_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    wb.save(output_path)
finally:
    try:
        wb.close()
    except Exception:
        pass

print(json.dumps({
    "ok": True,
    "postedSheetRowsRead": posted_rows_read,
    "validAtciRows": len(cleaned_rows),
    "removedNonAtciRows": removed_non_atci,
    "uniquePostedJrIds": len(posted_id_set),
    "matchingJrs": matching_jrs,
    "nonMatchingPostedJrs": non_matching_posted_jrs,
    "demandYesCount": demand_yes,
    "demandNoCount": demand_no,
    "masterRowsMarkedYes": master_yes,
    "masterRowsResetToDash": master_dash,
    "columnKUnchanged": True,
    "helperColumnsWritten": True,
    "postedColumn": "M",
    "postedColumnIndex": posted_col_m,
}))
`.trim();
}

export async function applyPostedSheetMatchingToStagedWorkbook(options: {
  localWorkbookPath: string;
  masterSheetName?: string;
  postedSheetName?: string;
}): Promise<PostedMatchingResult> {
  const workbookPath = options.localWorkbookPath;
  const masterSheetName =
    options.masterSheetName?.trim() || DEFAULT_LATERAL_MASTER_SHEET;
  const postedSheetName =
    options.postedSheetName?.trim() || POSTED_SHEET_NAME;

  if (!workbookPath || !existsSync(workbookPath)) {
    return {
      ok: false,
      error:
        "Staged Master Workbook was not found for Posted matching. Column M was not changed.",
      workbookUnchanged: true,
      columnKModified: false,
    };
  }

  const scriptPath = path.join(
    os.tmpdir(),
    `lateral-posted-match-${Date.now()}.py`
  );
  const outputPath = path.join(
    os.tmpdir(),
    `lateral-posted-match-out-${Date.now()}${path.extname(workbookPath) || ".xlsm"}`
  );

  try {
    await fs.writeFile(scriptPath, buildPostedMatchingPythonScript(), "utf8");
    const { stdout } = await execFileAsync(
      "python",
      [
        scriptPath,
        workbookPath,
        outputPath,
        masterSheetName,
        postedSheetName,
        JOB_REQUISITION_ID_HEADER,
        MASTER_POSTED_HEADER,
        String(MASTER_POSTED_COLUMN_M),
        String(MASTER_JOB_STATUS_COLUMN_K),
      ],
      {
        windowsHide: true,
        timeout: 300_000,
        maxBuffer: 16 * 1024 * 1024,
      }
    );

    const payload = JSON.parse((stdout || "").trim() || "{}") as {
      ok?: boolean;
      error?: string;
      postedSheetRowsRead?: number;
      validAtciRows?: number;
      removedNonAtciRows?: number;
      uniquePostedJrIds?: number;
      matchingJrs?: number;
      nonMatchingPostedJrs?: number;
      masterRowsMarkedYes?: number;
      masterRowsResetToDash?: number;
      demandYesCount?: number;
      demandNoCount?: number;
      columnKUnchanged?: boolean;
      helperColumnsWritten?: boolean;
    };

    if (!payload.ok) {
      return {
        ok: false,
        error:
          payload.error ||
          "Posted matching failed. Column M was not changed. Column K was not modified.",
        workbookUnchanged: true,
        columnKModified: false,
      };
    }

    if (!existsSync(outputPath)) {
      return {
        ok: false,
        error:
          "Posted matching did not produce an updated workbook. Column M was not changed.",
        workbookUnchanged: true,
        columnKModified: false,
      };
    }

    await fs.copyFile(outputPath, workbookPath);

    return {
      ok: true,
      postedSheet: POSTED_SHEET_NAME,
      masterSheet: masterSheetName,
      postedColumn: "M",
      postedColumnIndex: MASTER_POSTED_COLUMN_M,
      postedSheetColumns: {
        a: "posting",
        b: "Job Requisition ID",
        c: "Demand",
      },
      helperColumnsWritten: true,
      counts: {
        postedSheetRowsRead: payload.postedSheetRowsRead ?? 0,
        validAtciRows: payload.validAtciRows ?? 0,
        removedNonAtciRows: payload.removedNonAtciRows ?? 0,
        uniquePostedJrIds: payload.uniquePostedJrIds ?? 0,
        matchingJrs: payload.matchingJrs ?? 0,
        nonMatchingPostedJrs: payload.nonMatchingPostedJrs ?? 0,
        demandYesCount: payload.demandYesCount ?? 0,
        demandNoCount: payload.demandNoCount ?? 0,
        masterRowsMarkedYes: payload.masterRowsMarkedYes ?? 0,
        masterRowsResetToDash: payload.masterRowsResetToDash ?? 0,
        columnKUnchanged: true,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Posted matching failed: ${err.message}. Column M was not changed. Column K was not modified.`
          : "Posted matching failed unexpectedly. Column M was not changed. Column K was not modified.",
      workbookUnchanged: true,
      columnKModified: false,
    };
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
    await fs.unlink(outputPath).catch(() => undefined);
  }
}
