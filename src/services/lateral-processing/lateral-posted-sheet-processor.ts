/**
 * Posted Sheet A/B/C + Master Sheet Column M matching.
 *
 * Reproduces FilterAndMatchJobsPosted (Module2):
 *   A = cleaned posting text (not JR-only)
 *   B = Job Requisition ID (extracted from A)
 *   C = Demand Yes/No (Posted B matched to lateral_master JR)
 *   Master Column M = Posted Yes / -  (XLSM compatibility write)
 *   Job Status / Column K is never written
 *
 * Matching + write authority: PostgreSQL `lateral_master.posted` (primary).
 * Excel Column M is a secondary compatibility write for the Drive workbook;
 * the Lateral Master Sheet dashboard reads Postgres only.
 * PG writes (when persistDatabase=true): only `posted` + `updated_at` via
 * syncLateralPostedStatus().
 *
 * Ordering (documented, not a cross-system transaction):
 *   1) Clean Posted Sheet (may save workbook)
 *   2) PostgreSQL posted sync (when persistDatabase=true) — primary
 *   3) Excel final write (Demand + Column M, keep_vba) — compatibility
 * If step 2 succeeds and step 3 fails, PostgreSQL and XLSM can diverge.
 * Failure reporting must not claim the workbook is unchanged when PG was updated
 * or the Posted Sheet was already cleaned. Pipeline treats XLSM-only failure as
 * a warning and continues (Postgres-primary fail policy).
 *
 * Empty Posted JR list remains a safe no-op (no mass reset of posted='Yes').
 *
 * Runs on the staged local XLSM after Job Status reconciliation and before
 * confirmReconciliationSave().
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { syncLateralPostedStatus } from "@/services/lateral-processing/lateral-master-postgres";
import { DEFAULT_LATERAL_MASTER_SHEET } from "@/types/lateral-processing-setup";

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
  /** Postgres posted sync completed (primary). */
  postgresPostedSynced: true;
  /**
   * When set, XLSM Column M / Posted Sheet final write failed or was skipped,
   * but Postgres is authoritative — pipeline should continue with a warning.
   */
  xlsmMirrorWarning?: string;
}

export interface PostedMatchingFailure {
  ok: false;
  error: string;
  /**
   * False when Posted Sheet was already cleaned and/or PostgreSQL posted was
   * already updated before the failure. Never claim unchanged if PG changed.
   */
  workbookUnchanged: boolean;
  columnKModified: false;
  postgresPostedUpdated?: boolean;
  /** True when PG sync succeeded; caller may treat XLSM-only failures as soft. */
  postgresPostedSynced?: boolean;
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

/** Step B convention: prefer python3, then python, then Windows `py -3`. */
async function execPython(
  args: string[],
  options: { timeout: number; maxBuffer: number }
) {
  const common = {
    windowsHide: true as const,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    cwd: process.cwd(),
  };

  const attempts: Array<{ cmd: string; cmdArgs: string[] }> = [
    { cmd: "python3", cmdArgs: args },
    { cmd: "python", cmdArgs: args },
  ];
  if (process.platform === "win32") {
    attempts.push({ cmd: "py", cmdArgs: ["-3", ...args] });
  }

  let lastErr: unknown;
  for (const attempt of attempts) {
    try {
      return await execFileAsync(attempt.cmd, attempt.cmdArgs, common);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("No working Python interpreter (tried python3, python, py -3)");
}

export async function applyPostedSheetMatchingToStagedWorkbook(options: {
  localWorkbookPath: string;
  masterSheetName?: string;
  postedSheetName?: string;
  /**
   * Production defaults to true (writes lateral_master.posted).
   * Tests set false to match against PostgreSQL without modifying rows.
   */
  persistDatabase?: boolean;
}): Promise<PostedMatchingResult> {
  const workbookPath = options.localWorkbookPath;
  const postedSheetName =
    options.postedSheetName?.trim() || POSTED_SHEET_NAME;
  const persistDatabase = options.persistDatabase !== false;
  const masterSheetName =
    options.masterSheetName?.trim() || DEFAULT_LATERAL_MASTER_SHEET;

  if (!workbookPath || !existsSync(workbookPath)) {
    return {
      ok: false,
      error: "Staged workbook was not found for Posted processing.",
      workbookUnchanged: true,
      columnKModified: false,
    };
  }

  const scriptPath = path.join(
    os.tmpdir(),
    `lateral-posted-sheet-${Date.now()}.py`
  );

  let postedSheetCleaned = false;
  let postgresPostedUpdated = false;
  let postgresSyncCompleted = false;

  try {
    /*
     * Excel is used for Posted Sheet input/output and Column M mirror.
     * PostgreSQL lateral_master is the sole source of truth for matching.
     * Avoid openpyxl delete_rows (very slow on large sheets); overwrite in place.
     * Rows JSON is written to a temp file (not stdout) to avoid maxBuffer blowups.
     */
    const pythonScript = `
import json
import sys
from openpyxl import load_workbook

workbook_path = sys.argv[1]
posted_sheet_name = sys.argv[2]
out_json_path = sys.argv[3]

def clean(value):
    if value is None:
        return ""
    s = str(value)
    s = s.replace("\\u00a0", " ")
    s = s.replace("\\r\\n", " ")
    s = s.replace("\\r", " ")
    s = s.replace("\\n", " ")
    s = s.replace("\\t", " ")
    return " ".join(s.split()).strip()

def extract_jr(value):
    s = clean(value)
    if not s:
        return ""
    for i, ch in enumerate(s):
        if ch in (" ", "|"):
            return s[:i].strip()
    return s

try:
    wb = load_workbook(workbook_path, keep_vba=True, data_only=False)

    if posted_sheet_name not in wb.sheetnames:
        raise RuntimeError(
            f'Posted Sheet "{posted_sheet_name}" was not found.'
        )

    ws = wb[posted_sheet_name]

    last_row = ws.max_row or 1
    rows = []
    removed = 0

    for r in range(2, last_row + 1):
        original = ws.cell(r, 1).value
        cleaned = clean(original)

        if not cleaned.startswith("ATCI"):
            removed += 1
            continue

        jr = extract_jr(cleaned)
        if not jr:
            removed += 1
            continue

        rows.append((cleaned, jr))

    # Overwrite in place (no delete_rows — too slow on 5k+ rows with VBA).
    ws.cell(1, 1).value = ws.cell(1, 1).value or "Job Requisition"
    ws.cell(1, 2).value = "Job Requisition ID"
    ws.cell(1, 3).value = "Demand"

    for i, (cleaned, jr) in enumerate(rows, start=2):
        ws.cell(i, 1).value = cleaned
        ws.cell(i, 2).value = jr
        ws.cell(i, 3).value = None

    # Clear leftover trailing rows from a previous longer Posted list
    for r in range(len(rows) + 2, last_row + 1):
        ws.cell(r, 1).value = None
        ws.cell(r, 2).value = None
        ws.cell(r, 3).value = None

    wb.save(workbook_path)
    wb.close()

    with open(out_json_path, "w", encoding="utf-8") as f:
        json.dump({
            "ok": True,
            "postedSheetRowsRead": max(0, last_row - 1),
            "validAtciRows": len(rows),
            "removedNonAtciRows": removed,
            "rows": [
                {"posting": posting, "jr": jr}
                for posting, jr in rows
            ]
        }, f)
    print(json.dumps({"ok": True, "outPath": out_json_path, "validAtciRows": len(rows)}))

except Exception as exc:
    print(json.dumps({
        "ok": False,
        "error": str(exc)
    }))
`;

    const cleanOutJson = path.join(
      os.tmpdir(),
      `lateral-posted-rows-${Date.now()}.json`
    );
    await fs.writeFile(scriptPath, pythonScript, "utf8");

    const { stdout } = await execPython(
      [scriptPath, workbookPath, postedSheetName, cleanOutJson],
      {
        timeout: 600_000,
        maxBuffer: 32 * 1024 * 1024,
      }
    );

    const meta = JSON.parse((stdout || "").trim() || "{}") as {
      ok?: boolean;
      error?: string;
    };

    if (!meta.ok) {
      return {
        ok: false,
        error: meta.error || "Posted Sheet processing failed.",
        workbookUnchanged: true,
        columnKModified: false,
      };
    }

    const payload = JSON.parse(
      await fs.readFile(cleanOutJson, "utf8")
    ) as {
      ok?: boolean;
      error?: string;
      postedSheetRowsRead?: number;
      validAtciRows?: number;
      removedNonAtciRows?: number;
      rows?: Array<{
        posting: string;
        jr: string;
      }>;
    };
    await fs.unlink(cleanOutJson).catch(() => undefined);

    if (!payload.ok) {
      return {
        ok: false,
        error: payload.error || "Posted Sheet processing failed.",
        workbookUnchanged: true,
        columnKModified: false,
      };
    }

    // First Python stage saves the workbook (Posted Sheet cleaned).
    postedSheetCleaned = true;

    const rows = payload.rows ?? [];
    const uniqueJrs = [
      ...new Set(rows.map((row) => row.jr).filter(Boolean)),
    ];

    /*
     * Matching source (always PostgreSQL lateral_master):
     *   persistDatabase=true  → SELECT + UPDATE posted/updated_at
     *   persistDatabase=false → SELECT only (dry-run / tests)
     * Never assume every Posted JR is matched.
     */
    const dbResult = await syncLateralPostedStatus(uniqueJrs, persistDatabase);
    postgresSyncCompleted = persistDatabase;
    postgresPostedUpdated =
      persistDatabase &&
      (dbResult.markedYes > 0 || dbResult.resetToDash > 0);

    const matchedIds = new Set(dbResult.matchedIds);
    let masterRowsMarkedYes = persistDatabase ? dbResult.markedYes : 0;
    let masterRowsResetToDash = persistDatabase ? dbResult.resetToDash : 0;

    /*
     * Final workbook write MUST use openpyxl keep_vba=True.
     * Empty Posted JR list: do NOT mass-reset Master Column M to "-".
     * Matched IDs + Posted rows passed via temp JSON files (not embedded in .py).
     */
    const skipMasterPostedRewrite = uniqueJrs.length === 0;
    let xlsmMirrorWarning: string | undefined;

    const matchedJsonPath = path.join(
      os.tmpdir(),
      `lateral-posted-matched-${Date.now()}.json`
    );
    const rowsJsonPath = path.join(
      os.tmpdir(),
      `lateral-posted-final-rows-${Date.now()}.json`
    );
    await fs.writeFile(
      matchedJsonPath,
      JSON.stringify([...matchedIds]),
      "utf8"
    );
    await fs.writeFile(rowsJsonPath, JSON.stringify(rows), "utf8");

    const finalWriteScript = `
import json
import sys
from openpyxl import load_workbook

workbook_path = sys.argv[1]
posted_sheet_name = sys.argv[2]
master_sheet_name = sys.argv[3]
matched_json_path = sys.argv[4]
rows_json_path = sys.argv[5]
skip_master_posted = sys.argv[6] == "1"
posted_col_m = int(sys.argv[7])

with open(matched_json_path, "r", encoding="utf-8") as f:
    matched_ids = set(json.load(f))
with open(rows_json_path, "r", encoding="utf-8") as f:
    rows = json.load(f)

wb = load_workbook(workbook_path, keep_vba=True, data_only=False)

if posted_sheet_name not in wb.sheetnames:
    raise RuntimeError(
        f'Posted Sheet "{posted_sheet_name}" disappeared during final write.'
    )

if master_sheet_name not in wb.sheetnames:
    raise RuntimeError(
        f'Master Sheet "{master_sheet_name}" disappeared during final write.'
    )

posted_ws = wb[posted_sheet_name]
master_ws = wb[master_sheet_name]

demand_yes = 0
demand_no = 0

for i, row in enumerate(rows, start=2):
    posting = str(row.get("posting") or "").strip()
    jr = str(row.get("jr") or "").strip()
    demand = "Yes" if jr in matched_ids else "No"

    posted_ws.cell(i, 1).value = posting
    posted_ws.cell(i, 2).value = jr
    posted_ws.cell(i, 3).value = demand

    if demand == "Yes":
        demand_yes += 1
    else:
        demand_no += 1

master_yes = 0
master_dash = 0
master_rows_marked_yes = 0
master_rows_reset_to_dash = 0

if not skip_master_posted:
    for r in range(2, (master_ws.max_row or 1) + 1):
        jr = str(master_ws.cell(r, 2).value or "").strip()
        if not jr:
            continue

        cell = master_ws.cell(r, posted_col_m)
        previous = str(cell.value or "").strip()
        target = "Yes" if jr in matched_ids else "-"

        if target == "Yes":
            master_yes += 1
            if previous != "Yes":
                master_rows_marked_yes += 1
        else:
            master_dash += 1
            if previous == "Yes":
                master_rows_reset_to_dash += 1

        cell.value = target

wb.save(workbook_path)
wb.close()

print(json.dumps({
    "ok": True,
    "demandYes": demand_yes,
    "demandNo": demand_no,
    "masterYes": master_yes,
    "masterDash": master_dash,
    "masterRowsMarkedYes": master_rows_marked_yes,
    "masterRowsResetToDash": master_rows_reset_to_dash,
    "skippedMasterPostedRewrite": skip_master_posted
}))
`;

    const finalWritePath = path.join(
      os.tmpdir(),
      `lateral-posted-final-${Date.now()}.py`
    );

    try {
      await fs.writeFile(finalWritePath, finalWriteScript, "utf8");

      try {
        const { stdout: finalWriteStdout } = await execPython(
          [
            finalWritePath,
            workbookPath,
            postedSheetName,
            masterSheetName,
            matchedJsonPath,
            rowsJsonPath,
            skipMasterPostedRewrite ? "1" : "0",
            String(MASTER_POSTED_COLUMN_M),
          ],
          {
            timeout: 600_000,
            maxBuffer: 32 * 1024 * 1024,
          }
        );

        const finalWrite = JSON.parse(
          (finalWriteStdout || "").trim() || "{}"
        ) as {
          ok?: boolean;
          demandYes?: number;
          demandNo?: number;
          masterYes?: number;
          masterDash?: number;
          masterRowsMarkedYes?: number;
          masterRowsResetToDash?: number;
          error?: string;
        };

        if (finalWrite.ok === false) {
          throw new Error(finalWrite.error || "XLSM Posted final write failed.");
        }

        if (!persistDatabase) {
          masterRowsMarkedYes = finalWrite.masterRowsMarkedYes ?? 0;
          masterRowsResetToDash = finalWrite.masterRowsResetToDash ?? 0;
        }
      } catch (xlsmErr) {
        // Postgres is primary. XLSM Column M is secondary compatibility only.
        if (persistDatabase && postgresSyncCompleted) {
          xlsmMirrorWarning = `XLSM Posted Sheet / Column M mirror failed after Postgres posted sync succeeded: ${
            xlsmErr instanceof Error ? xlsmErr.message : String(xlsmErr)
          }. Dashboard Master Sheet uses Postgres; re-run Step 18 later to refresh the XLSM mirror if needed.`;
          console.warn("[lateral-posted]", xlsmMirrorWarning);
        } else {
          throw xlsmErr;
        }
      }
    } finally {
      await fs.unlink(finalWritePath).catch(() => undefined);
      await fs.unlink(matchedJsonPath).catch(() => undefined);
      await fs.unlink(rowsJsonPath).catch(() => undefined);
    }

    return {
      ok: true,
      postedSheet: POSTED_SHEET_NAME,
      masterSheet: "PostgreSQL lateral_master",
      postedColumn: "M",
      postedColumnIndex: MASTER_POSTED_COLUMN_M,
      postedSheetColumns: {
        a: "posting",
        b: "Job Requisition ID",
        c: "Demand",
      },
      helperColumnsWritten: true,
      postgresPostedSynced: true,
      xlsmMirrorWarning,
      counts: {
        postedSheetRowsRead: payload.postedSheetRowsRead ?? 0,
        validAtciRows: payload.validAtciRows ?? 0,
        removedNonAtciRows: payload.removedNonAtciRows ?? 0,
        uniquePostedJrIds: uniqueJrs.length,
        matchingJrs: matchedIds.size,
        nonMatchingPostedJrs: uniqueJrs.filter((jr) => !matchedIds.has(jr))
          .length,
        demandYesCount: rows.filter((row) => matchedIds.has(row.jr)).length,
        demandNoCount: rows.filter((row) => !matchedIds.has(row.jr)).length,
        masterRowsMarkedYes,
        masterRowsResetToDash,
        columnKUnchanged: true,
      },
    };
  } catch (err) {
    const base =
      err instanceof Error
        ? `Posted PostgreSQL matching failed: ${err.message}`
        : "Posted PostgreSQL matching failed unexpectedly.";

    const warnings: string[] = [];
    if (postgresPostedUpdated) {
      warnings.push(
        "WARNING: PostgreSQL lateral_master.posted was already updated before this failure. Excel final write may be incomplete — re-run Step 18 to reconcile."
      );
    } else if (postgresSyncCompleted) {
      warnings.push(
        "PostgreSQL posted sync completed with no row changes before this failure."
      );
    }
    if (postedSheetCleaned) {
      warnings.push(
        "Posted Sheet may already have been cleaned/saved on the staged workbook."
      );
    }

    // If Postgres already synced, treat as soft success for pipeline continuation.
    if (postgresSyncCompleted) {
      return {
        ok: true,
        postedSheet: POSTED_SHEET_NAME,
        masterSheet: "PostgreSQL lateral_master",
        postedColumn: "M",
        postedColumnIndex: MASTER_POSTED_COLUMN_M,
        postedSheetColumns: {
          a: "posting",
          b: "Job Requisition ID",
          c: "Demand",
        },
        helperColumnsWritten: true,
        postgresPostedSynced: true,
        xlsmMirrorWarning: warnings.length
          ? `${base} ${warnings.join(" ")}`
          : base,
        counts: {
          postedSheetRowsRead: 0,
          validAtciRows: 0,
          removedNonAtciRows: 0,
          uniquePostedJrIds: 0,
          matchingJrs: 0,
          nonMatchingPostedJrs: 0,
          demandYesCount: 0,
          demandNoCount: 0,
          masterRowsMarkedYes: 0,
          masterRowsResetToDash: 0,
          columnKUnchanged: true,
        },
      };
    }

    return {
      ok: false,
      error: warnings.length ? `${base} ${warnings.join(" ")}` : base,
      workbookUnchanged: !(postedSheetCleaned || postgresPostedUpdated),
      columnKModified: false,
      postgresPostedUpdated,
      postgresPostedSynced: postgresSyncCompleted,
    };
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}
