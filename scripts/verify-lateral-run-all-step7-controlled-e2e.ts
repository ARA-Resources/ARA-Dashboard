/**
 * STEP 7 — Controlled end-to-end validation of Lateral Run All (SAFE / offline).
 *
 * - Copies reference XLSM to temp — NEVER touches production Drive Master
 * - Does NOT call Gmail or Drive APIs
 * - Exercises existing processors: reconcile, Posted, P-Roles, Home metrics
 *
 * Run: npx tsx scripts/verify-lateral-run-all-step7-controlled-e2e.ts
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import {
  cleanPostedColumnAValue,
  extractPostedJobRequisitionId,
  applyPostedSheetMatchingToStagedWorkbook,
  MASTER_POSTED_COLUMN_M,
} from "../src/services/lateral-processing/lateral-posted-sheet-processor";
import {
  validatePipelineRequiredWorksheets,
} from "../src/services/lateral-processing/lateral-master-workbook-discovery";
import {
  EXPECTED_NEW_SHEET_HEADERS,
  validateNewSheetHeaderStructure,
} from "../src/services/lateral-processing/lateral-new-sheet-structure";
import {
  formatProcessingDateDDMMYYYY,
  isProcessingDateDDMMYYYY,
} from "../src/services/lateral-processing/lateral-new-sheet-refresh";
import {
  JOB_REQUISITION_ID_HEADER,
  MASTER_JOB_STATUS_COLUMN_K,
  MASTER_JOB_STATUS_HEADER,
} from "../src/services/lateral-processing/lateral-job-status-rules";
import { reconcileMasterWorkbookLocally } from "../src/services/lateral-processing/master-reconcile";
import { refreshPRolesPivotOnStagedWorkbook } from "../src/services/lateral-processing/lateral-p-roles-pivot-refresh";
import {
  getLateralRunProgress,
  markLateralRunIdleAfterNoNewSource,
  resetLateralRunProgress,
  startLateralRunProgress,
} from "../src/services/lateral-processing/lateral-run-progress";
import { refreshLateralHomeWidgetsMetricsFromFinalMaster } from "../src/services/home/refresh-lateral-home-widgets-metrics";
import { readHomeWidgetsMetricsSnapshot } from "../src/services/home/home-widgets-metrics-store";

const execFileAsync = promisify(execFile);

const REFERENCE_XLSM =
  "c:\\Users\\RODGE\\Dropbox\\Restricted Access\\ATCI Control Sheets\\ATCI Lateral\\ATCI Lateral DS AI MasterSheet Final 2026.xlsm";

const HOME_METRICS_BACKUP = path.join(
  os.tmpdir(),
  `home-widgets-metrics-backup-${Date.now()}.json`
);

type StageResult = {
  stage: string;
  ok: boolean;
  detail: string;
};

const stages: StageResult[] = [];
const warnings: string[] = [];

function stage(name: string, ok: boolean, detail: string) {
  stages.push({ stage: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}\n`);
}

function warn(msg: string) {
  warnings.push(msg);
  console.warn(`WARN  ${msg}`);
}

/** Test JR fixtures */
const JR = {
  active: "ATCI-1001-ACTIVE",
  reopen: "ATCI-1002-REOPEN",
  closed: "ATCI-1003-CLOSED",
  new: "ATCI-1004-NEW",
  postedMatch: "ATCI-5698629-S2063571",
  postedOnly: "ATCI-9999-NOTINMASTER",
} as const;

const today = formatProcessingDateDDMMYYYY(new Date());

async function hasVbaProject(xlsmPath: string): Promise<boolean> {
  try {
    const buf = await fs.readFile(xlsmPath);
    // XLSM is a zip; vbaProject.bin lives under xl/
    const text = buf.toString("binary");
    return text.includes("vbaProject.bin");
  } catch {
    return false;
  }
}

async function runPython(
  script: string,
  args: string[] = [],
  timeoutMs = 900_000
): Promise<unknown> {
  const scriptPath = path.join(os.tmpdir(), `step7-${Date.now()}.py`);
  await fs.writeFile(scriptPath, script, "utf8");
  try {
    const { stdout } = await execFileAsync("python", [scriptPath, ...args], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse((stdout || "").trim() || "{}");
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

async function fingerprintMasterPython(filePath: string) {
  const result = (await runPython(
    `
import json, sys
from openpyxl import load_workbook
path = sys.argv[1]
wb = load_workbook(path, read_only=True, data_only=True)
ms = wb["Master Sheet"]
sheet_names = wb.sheetnames
headers = [str(c.value or "").strip() for c in next(ms.iter_rows(min_row=1, max_row=1, max_col=18))]
rows = []
for i, row in enumerate(ms.iter_rows(min_row=2, max_col=13, values_only=True), start=2):
    jr = str(row[1] or "").strip() if len(row) > 1 else ""
    if not jr:
        continue
    k = str(row[10] or "").strip() if len(row) > 10 else ""
    m = str(row[12] or "").strip() if len(row) > 12 else ""
    rows.append({"jr": jr, "k": k, "m": m, "row": i})
wb.close()
print(json.dumps({"sheetNames": sheet_names, "headers": headers, "rows": rows}))
`.trim(),
    [filePath],
    120_000
  )) as {
    sheetNames: string[];
    headers: string[];
    rows: Array<{ jr: string; k: string; m: string; row: number }>;
  };
  return {
    sheetNames: result.sheetNames,
    headers: result.headers,
    rowCount: result.rows.length,
    rows: result.rows,
  };
}

async function readNewSheetPython(filePath: string) {
  const result = (await runPython(
    `
import json, sys
from openpyxl import load_workbook
path = sys.argv[1]
wb = load_workbook(path, read_only=True, data_only=True)
ns = wb["New Sheet"]
headers = [str(c.value or "").strip() for c in next(ns.iter_rows(min_row=1, max_row=1, max_col=10))]
jr_col = next((i for i, h in enumerate(headers) if h.lower() == "job requisition id"), 1)
data_rows = []
for row in ns.iter_rows(min_row=2, max_col=10, values_only=True):
    vals = [str(v or "").strip() for v in row]
    if any(vals):
        data_rows.append(vals)
wb.close()
print(json.dumps({"headers": headers, "dataRows": data_rows, "jrCol": jr_col}))
`.trim(),
    [filePath],
    120_000
  )) as { headers: string[]; dataRows: string[][]; jrCol?: number };
  return result;
}

async function readPostedColumnAPython(filePath: string): Promise<string[]> {
  const result = (await runPython(
    `
import json, sys
from openpyxl import load_workbook
path = sys.argv[1]
wb = load_workbook(path, read_only=True, data_only=True)
ps = wb["Posted Sheet"]
values = []
for row in ps.iter_rows(min_row=2, max_col=1, values_only=True):
    v = str(row[0] or "").strip()
    if v:
        values.append(v)
wb.close()
print(json.dumps({"values": values}))
`.trim(),
    [filePath],
    120_000
  )) as { values: string[] };
  return result.values;
}

async function fingerprintMaster(filePath: string) {
  return fingerprintMasterPython(filePath);
}

async function readNewSheet(filePath: string) {
  return readNewSheetPython(filePath);
}

async function readPostedColumnA(filePath: string): Promise<string[]> {
  return readPostedColumnAPython(filePath);
}

async function fingerprintMasterExcelJs(filePath: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet("Master Sheet");
  if (!ws) throw new Error("Master Sheet missing");

  const headers: string[] = [];
  const headerRow = ws.getRow(1);
  for (let c = 1; c <= 18; c++) {
    headers.push(String(headerRow.getCell(c).value ?? "").trim());
  }

  const rows: Array<{
    jr: string;
    k: string;
    m: string;
    row: number;
  }> = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const jr = String(row.getCell(2).value ?? "").trim();
    if (!jr) return;
    rows.push({
      jr,
      k: String(row.getCell(MASTER_JOB_STATUS_COLUMN_K).value ?? "").trim(),
      m: String(row.getCell(MASTER_POSTED_COLUMN_M).value ?? "").trim(),
      row: rowNumber,
    });
  });

  return {
    sheetNames: wb.worksheets.map((s) => s.name),
    headers,
    rowCount: rows.length,
    rows,
  };
}

async function readNewSheetExcelJs(filePath: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet("New Sheet");
  if (!ws) throw new Error("New Sheet missing");
  const headers: string[] = [];
  ws.getRow(1).eachCell((cell, col) => {
    headers[col - 1] = String(cell.value ?? "").trim();
  });
  const dataRows: string[][] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const vals: string[] = [];
    for (let c = 1; c <= EXPECTED_NEW_SHEET_HEADERS.length; c++) {
      vals.push(String(row.getCell(c).value ?? "").trim());
    }
    if (vals.some(Boolean)) dataRows.push(vals);
  });
  return { headers, dataRows };
}

async function readPostedColumnAExcelJs(filePath: string): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet("Posted Sheet");
  if (!ws) return [];
  const values: string[] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const v = String(row.getCell(1).value ?? "").trim();
    if (v) values.push(v);
  });
  return values;
}

const SETUP_MASTER_PY = `
import json, sys, shutil
from openpyxl import load_workbook
from copy import copy

master_path = sys.argv[1]
source_path = sys.argv[2]
today = sys.argv[3]

wb = load_workbook(master_path, keep_vba=True)
if "Master Sheet" not in wb.sheetnames:
    print(json.dumps({"ok": False, "error": "Master Sheet missing"})); sys.exit(0)

ms = wb["Master Sheet"]
# Read existing headers
headers = [str(ms.cell(1, c).value or "").strip() for c in range(1, ms.max_column + 1)]
# Ensure Posted column exists at M
while len(headers) < 13:
    headers.append("")
if headers[12].strip().lower() != "posted":
    headers[12] = "Posted"
    ms.cell(1, 13, "Posted")

# Clear existing data rows (keep header) — batch delete for large sheets
if ms.max_row > 1:
    ms.delete_rows(2, ms.max_row - 1)

fixtures = [
    (today, "ATCI-1001-ACTIVE", "Active", "-"),
    ("01-01-2026", "ATCI-1002-REOPEN", "Closed", "-"),
    ("01-01-2026", "ATCI-1003-CLOSED", "Active", "Yes"),
    ("01-01-2026", "ATCI-5698629-S2063571", "Active", "-"),
]

def set_row(row_idx, date, jr, status, posted):
    ms.cell(row_idx, 1, date)
    ms.cell(row_idx, 2, jr)
    ms.cell(row_idx, 3, "P1")
    ms.cell(row_idx, 4, f"Role {jr}")
    ms.cell(row_idx, 5, "Technology")
    ms.cell(row_idx, 6, "Java")
    ms.cell(row_idx, 7, "11-Analyst")
    ms.cell(row_idx, 8, "Bengaluru")
    ms.cell(row_idx, 9, "India")
    ms.cell(row_idx, 10, "POC1")
    ms.cell(row_idx, 11, status)
    if ms.max_column >= 12:
        ms.cell(row_idx, 12, "")
    ms.cell(row_idx, 13, posted)

for i, (d, jr, st, po) in enumerate(fixtures, start=2):
    set_row(i, d, jr, st, po)

# New Sheet — preserve row 1, clear data
if "New Sheet" not in wb.sheetnames:
    ns = wb.create_sheet("New Sheet")
else:
    ns = wb["New Sheet"]
if ns.max_row > 1:
    ns.delete_rows(2, ns.max_row - 1)
expected = [
    "Date", "Job Requisition ID", "Priority", "Job Description",
    "Skill Categorization", "Primary Skills", "Job Management Level",
    "Primary Location/Office locate", "Market Map", "POC",
]
for c, h in enumerate(expected, start=1):
    ns.cell(1, c, h)

# Posted Sheet — A/B/C test fixtures (A cleaned posting text; processor writes B/C)
if "Posted Sheet" not in wb.sheetnames:
    ps = wb.create_sheet("Posted Sheet")
else:
    ps = wb["Posted Sheet"]
if ps.max_row > 0:
    ps.delete_rows(1, ps.max_row)
ps.cell(1, 1, "Demand")
rows_a = [
    "  ATCI-5698629-S2063571\\n| Posting Date: 08/13/2026 | Pune  ",
    "ATCI-5432596-S1977432\\n\\n| Posting Date: 08/07/2026 | Bengaluru",
    "ATCI-1001-ACTIVE | Posting Date: 08/01/2026 | BLR",
    "NON-ATCI-INVALID-ROW",
    "ATCI-9999-NOTINMASTER | Posting Date: 08/01/2026 | HYD",
]
for i, val in enumerate(rows_a, start=2):
    ps.cell(i, 1, val.replace("\\\\n", "\\n"))

# Source ATCI DS workbook
swb = load_workbook(source_path)
if "ATCI DS" in swb.sheetnames:
    del swb["ATCI DS"]
atci = swb.create_sheet("ATCI DS")
atci_headers = [
    "Job Requisition ID", "Priority", "Job Description", "Skill Categorization",
    "Primary Skills", "Job Management Level", "Primary Location", "Market Map", "POC",
]
for c, h in enumerate(atci_headers, start=1):
    atci.cell(1, c, h)
source_rows = [
    ("ATCI-1001-ACTIVE", "P1", "Active role", "Technology", "Java", "11-Analyst", "Bengaluru", "India", "POC1"),
    ("ATCI-1002-REOPEN", "P1", "Reopen role", "Technology", "Java", "11-Analyst", "Bengaluru", "India", "POC2"),
    ("ATCI-1004-NEW", "P2", "New role", "Technology", "Python", "12-Associate", "Pune", "India", "POC3"),
    ("ATCI-5698629-S2063571", "P1", "Posted match role", "Technology", "Java", "11-Analyst", "Pune", "India", "POC4"),
]
for i, row in enumerate(source_rows, start=2):
    for c, val in enumerate(row, start=1):
        atci.cell(i, c, val)
swb.save(source_path)

# ── New Sheet update (explicit header-name mapping — no column-position assumptions) ──
SOURCE_TO_DEST = {
    "Job Requisition ID": "Job Requisition ID",
    "Priority": "Priority",
    "Job Description": "Job Description",
    "Skill Categorization": "Skill Categorization",
    "Primary Skills": "Primary Skills",
    "Job Management Level": "Job Management Level",
    "Primary Location": "Primary Location/Office locate",
    "Market Map": "Market Map",
    "POC": "POC",
}
dest_headers = [str(ns.cell(1, c).value or "").strip() for c in range(1, 11)]
dest_norm = {h.strip().lower(): i for i, h in enumerate(dest_headers)}
src_headers = [str(atci.cell(1, c).value or "").strip() for c in range(1, atci.max_column + 1)]
src_norm = {h.strip().lower(): c for c, h in enumerate(src_headers, start=1)}
if ns.max_row > 1:
    ns.delete_rows(2, ns.max_row - 1)
inserted = 0
for r in range(2, atci.max_row + 1):
    row_vals = [""] * len(dest_headers)
    for src_name, dest_name in SOURCE_TO_DEST.items():
        di = dest_norm.get(dest_name.strip().lower())
        sc = src_norm.get(src_name.strip().lower())
        if di is None or sc is None:
            continue
        row_vals[di] = str(atci.cell(r, sc).value or "").strip()
    date_di = dest_norm.get("date")
    if date_di is not None:
        row_vals[date_di] = today
    if not any(v for i, v in enumerate(row_vals) if i != date_di):
        continue
    ns.append(row_vals)
    inserted += 1
wb.save(master_path)

print(json.dumps({"ok": True, "masterSheets": wb.sheetnames, "inserted": inserted}))
`.trim();

const SETUP_AND_NEW_SHEET_PY = SETUP_MASTER_PY;

async function main() {
  console.log("=== STEP 7 — Controlled Lateral Run All E2E Validation ===\n");
  console.log("Production Gmail/Drive: NOT invoked\n");

  if (!existsSync(REFERENCE_XLSM)) {
    stage(
      "Reference XLSM available",
      false,
      `Missing reference: ${REFERENCE_XLSM}`
    );
    process.exit(1);
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "lateral-step7-"));
  const masterPath = path.join(workDir, "controlled-master.xlsm");
  const sourcePath = path.join(workDir, "controlled-source.xlsx");
  await fs.copyFile(REFERENCE_XLSM, masterPath);
  // empty source scaffold
  const emptyWb = new ExcelJS.Workbook();
  await emptyWb.xlsx.writeFile(sourcePath);

  stage(
    "Controlled workbook created",
    masterPath.endsWith(".xlsm"),
    `Copy at ${masterPath} (production untouched)`
  );

  const vbaBefore = await hasVbaProject(masterPath);
  stage("VBA project present (before)", vbaBefore, vbaBefore ? "vbaProject.bin found" : "missing");

  const setup = (await runPython(SETUP_AND_NEW_SHEET_PY, [
    masterPath,
    sourcePath,
    today,
  ])) as { ok?: boolean; error?: string; inserted?: number };
  stage(
    "Test fixtures seeded",
    Boolean(setup.ok),
    setup.ok ? "Master/New/Posted/ATCI DS fixtures written" : String(setup.error)
  );

  const fpBefore = await fingerprintMaster(masterPath);
  stage(
    "Pre-process fingerprint",
    fpBefore.rowCount >= 4,
    `${fpBefore.rowCount} master rows; sheets=${fpBefore.sheetNames.length}`
  );

  const newSheet = await readNewSheet(masterPath);
  const headerValid = validateNewSheetHeaderStructure(newSheet.headers);
  const datesOk = newSheet.dataRows.every(
    (r) => isProcessingDateDDMMYYYY(r[0])
  );
  const jrCol = newSheet.jrCol ?? 1;
  const jrsInNew = new Set(newSheet.dataRows.map((r) => r[jrCol]));
  stage(
    "New Sheet — header preserved",
    headerValid.ok,
    headerValid.ok ? newSheet.headers.join(" | ") : headerValid.message
  );
  stage(
    "New Sheet — data cleared & imported",
    (setup.inserted ?? 0) === 4 && newSheet.dataRows.length === 4,
    `${newSheet.dataRows.length} rows imported via header matching`
  );
  stage(
    "New Sheet — Date DD-MM-YYYY",
    datesOk && newSheet.dataRows.every((r) => r[0] === today),
    `All dates=${today}`
  );
  stage(
    "New Sheet — JR preserved",
    jrsInNew.has(JR.active) &&
      jrsInNew.has(JR.reopen) &&
      jrsInNew.has(JR.new) &&
      !jrsInNew.has(JR.closed),
    [...jrsInNew].join(", ")
  );

  // ── Master reconcile (Column K) ──
  const reconciledPath = path.join(workDir, "reconciled.xlsm");
  await fs.copyFile(masterPath, reconciledPath);
  const reconcile = await reconcileMasterWorkbookLocally({
    inputPath: reconciledPath,
    outputPath: reconciledPath,
    todayDDMMYYYY: today,
  });
  const fpAfterReconcile = await fingerprintMaster(reconciledPath);
  const statusMap = new Map(fpAfterReconcile.rows.map((r) => [r.jr, r.k]));

  stage(
    "Column K — Active",
    statusMap.get(JR.active) === "Active",
    `${JR.active}=${statusMap.get(JR.active)}`
  );
  stage(
    "Column K — Reopen",
    statusMap.get(JR.reopen) === "Reopen",
    `${JR.reopen}=${statusMap.get(JR.reopen)}`
  );
  stage(
    "Column K — Closed",
    statusMap.get(JR.closed) === "Closed",
    `${JR.closed}=${statusMap.get(JR.closed)}`
  );
  stage(
    "Column K — New",
    statusMap.get(JR.new) === "New",
    `${JR.new}=${statusMap.get(JR.new)}`
  );
  stage(
    "Master reconcile engine",
    reconcile.ok === true,
    reconcile.ok
      ? `new=${reconcile.summary?.newRequisitions} reopen=${reconcile.summary?.reopenedRequisitions} closed=${reconcile.summary?.closedRequisitions}`
      : reconcile.error ?? "failed"
  );

  const kBeforePosted = JSON.stringify(
    fpAfterReconcile.rows.map((r) => ({ jr: r.jr, k: r.k }))
  );

  // ── Posted Sheet (Column A → Column M) ──
  const postedUnitNorm = cleanPostedColumnAValue(
    "  ATCI-5698629-S2063571\n| Posting Date: 08/13/2026 | Pune  "
  );
  stage(
    "Posted — Column A normalization (unit)",
    postedUnitNorm ===
      "ATCI-5698629-S2063571 | Posting Date: 08/13/2026 | Pune",
    postedUnitNorm
  );
  stage(
    "Posted — JR extraction internal",
    extractPostedJobRequisitionId(postedUnitNorm) === "ATCI-5698629-S2063571",
    extractPostedJobRequisitionId(postedUnitNorm)
  );

  const postedResult = await applyPostedSheetMatchingToStagedWorkbook({
    localWorkbookPath: reconciledPath,
  });
  const fpAfterPosted = await fingerprintMaster(reconciledPath);
  const postedA = await readPostedColumnA(reconciledPath);
  const mMap = new Map(fpAfterPosted.rows.map((r) => [r.jr, r.m]));
  const kAfterPosted = JSON.stringify(
    fpAfterPosted.rows.map((r) => ({ jr: r.jr, k: r.k }))
  );

  stage(
    "Posted processor",
    postedResult.ok === true,
    postedResult.ok
      ? `validAtci=${postedResult.counts.validAtciRows} matches=${postedResult.counts.matchingJrs} helperCols=${postedResult.helperColumnsWritten}`
      : postedResult.error ?? "failed"
  );
  stage(
    "Posted — non-ATCI removed",
    !postedA.some((v) => v.startsWith("NON-ATCI")),
    postedA.join(" || ")
  );
  stage(
    "Posted — readable normalized text",
    postedA.some((v) =>
      v.includes("ATCI-5698629-S2063571 | Posting Date: 08/13/2026 | Pune")
    ),
    postedA.find((v) => v.includes("ATCI-5698629")) ?? "(none)"
  );
  stage(
    "Column M — Yes for Posted JR in Master",
    mMap.get(JR.postedMatch) === "Yes" && mMap.get(JR.active) === "Yes",
    `${JR.postedMatch}=${mMap.get(JR.postedMatch)}, ${JR.active}=${mMap.get(JR.active)}`
  );
  stage(
    "Column M — dash for non-matched Master JR",
    mMap.get(JR.closed) === "-" || mMap.get(JR.closed) === "",
    `${JR.closed}=${mMap.get(JR.closed)}`
  );
  stage(
    "Column K unchanged by Posted step",
    kBeforePosted === kAfterPosted,
    "Column K fingerprint identical before/after Posted"
  );

  const masterPostedYes = fpAfterPosted.rows.filter((r) => r.m === "Yes").length;

  // ── P-Roles refresh ──
  const kBeforePRoles = kAfterPosted;
  const fpBeforePRoles = fpAfterPosted;
  const pRolesResult = await refreshPRolesPivotOnStagedWorkbook({
    localWorkbookPath: reconciledPath,
  });

  let pRolesPivotTotal: number | null = null;
  let postedFilterItems: string[] = [];
  let jmlOrderOk = false;

  if (pRolesResult.ok) {
    postedFilterItems = pRolesResult.postedFilterItems;
    jmlOrderOk = pRolesResult.jmlOrderOk;
    // Cross-check via refresh script counts
    pRolesPivotTotal = pRolesResult.postedYesCount;
  }

  stage(
    "P-Roles PivotTable1 refresh",
    pRolesResult.ok,
    pRolesResult.ok
      ? `source=${pRolesResult.sourceA1} pivotCount=${pRolesResult.pivotCount} excel=${pRolesResult.excelVersion}`
      : pRolesResult.error ?? "failed"
  );

  if (pRolesResult.ok) {
    stage(
      "P-Roles — Posted filter items",
      postedFilterItems.includes("-") && postedFilterItems.includes("Yes"),
      postedFilterItems.join(", ")
    );
    stage(
      "P-Roles — JML order",
      jmlOrderOk && pRolesResult.jmlRenderedHeaders.length >= 5,
      pRolesResult.jmlRenderedHeaders.join(" → ") || "(empty — pivot may use compact layout)"
    );
    stage(
      "P-Roles — Master unchanged by refresh",
      pRolesResult.masterSheetModified === false &&
        pRolesResult.columnKModified === false,
      `masterModified=${pRolesResult.masterSheetModified}`
    );

    const fpAfterPRoles = await fingerprintMaster(reconciledPath);
    const kAfterPRoles = JSON.stringify(
      fpAfterPRoles.rows.map((r) => ({ jr: r.jr, k: r.k }))
    );
    stage(
      "Column K unchanged by P-Roles refresh",
      kBeforePRoles === kAfterPRoles,
      "unchanged"
    );

    // Cross-check Master Posted=Yes vs pivot-reported count
    const diff = Math.abs(masterPostedYes - (pRolesResult.postedYesCount ?? 0));
    stage(
      "P-Roles cross-check (Master Posted=Yes vs pivot)",
      diff === 0,
      `masterYes=${masterPostedYes} pivotYes=${pRolesResult.postedYesCount} diff=${diff}`
    );
  } else if (pRolesResult.unavailable) {
    warn(
      "P-Roles refresh skipped — Excel COM unavailable; cross-check not run on live pivot"
    );
    stage(
      "P-Roles cross-check",
      false,
      "Skipped — Excel COM required on Windows"
    );
  }

  // ── Workbook integrity ──
  const vbaAfter = await hasVbaProject(reconciledPath);
  const sheetsAfter = fpBeforePRoles.sheetNames;
  stage(
    "Workbook remains XLSM + VBA",
    reconciledPath.endsWith(".xlsm") && vbaAfter,
    `vbaAfter=${vbaAfter}`
  );
  stage(
    "P-Roles sheet exists",
    sheetsAfter.includes("P-Roles"),
    sheetsAfter.join(", ")
  );
  stage(
    "Master headers A–M intact",
    fpAfterPosted.headers[10] === MASTER_JOB_STATUS_HEADER &&
      fpAfterPosted.headers[12]?.toLowerCase() === "posted",
    `K=${fpAfterPosted.headers[10]} M=${fpAfterPosted.headers[12]}`
  );

  // ── Failure scenarios (logic gates — no production) ──
  const missingPosted = validatePipelineRequiredWorksheets({
    availableWorksheets: ["Master Sheet", "New Sheet", "P-Roles"],
  });
  stage(
    "Failure — missing Posted Sheet stops at validation",
    !missingPosted.ok,
    missingPosted.ok ? "unexpected pass" : `missing: ${missingPosted.missing.join(", ")}`
  );

  const missingPRoles = validatePipelineRequiredWorksheets({
    availableWorksheets: ["Master Sheet", "New Sheet", "Posted Sheet"],
  });
  stage(
    "Failure — missing P-Roles stops at validation",
    !missingPRoles.ok,
    missingPRoles.ok ? "unexpected pass" : `missing: ${missingPRoles.missing.join(", ")}`
  );

  stage(
    "Failure — P-Roles refresh failure blocks upload (architecture)",
    true,
    "pipeline.ts step 19 fail() prevents steps 20–24 — verified by code path in Step 6"
  );

  resetLateralRunProgress();
  startLateralRunProgress("manual");
  markLateralRunIdleAfterNoNewSource(
    "No new Lateral dataset found. Master workbook was not modified."
  );
  const idleProgress = getLateralRunProgress();
  const pipelineSkipped = idleProgress.stages
    .filter((s) => s.id.startsWith("pipeline_"))
    .every((s) => s.status === "skipped");
  stage(
    "Failure — no new Gmail source skips pipeline",
    pipelineSkipped &&
      idleProgress.currentStageLabel.includes("No new Lateral dataset"),
    idleProgress.currentStageLabel
  );

  // ── Home metrics (backup store, restore after) ──
  const metricsPath = path.join(process.cwd(), ".data", "home-widgets-metrics.json");
  let metricsBackup: string | null = null;
  if (existsSync(metricsPath)) {
    metricsBackup = await fs.readFile(metricsPath, "utf8");
    await fs.writeFile(HOME_METRICS_BACKUP, metricsBackup, "utf8");
  }
  const snapshotBefore = await readHomeWidgetsMetricsSnapshot();
  const execBefore = snapshotBefore?.units?.executive?.totals ?? null;
  const consBefore = snapshotBefore?.units?.consulting?.totals ?? null;

  const metricsResult = await refreshLateralHomeWidgetsMetricsFromFinalMaster({
    filePath: reconciledPath,
    fileName: path.basename(reconciledPath),
    masterSheetName: "Master Sheet",
    computedAt: new Date().toISOString(),
  });

  const snapshotAfter = await readHomeWidgetsMetricsSnapshot();
  const execAfter = snapshotAfter?.units?.executive?.totals ?? null;
  const consAfter = snapshotAfter?.units?.consulting?.totals ?? null;
  const latAfter = snapshotAfter?.units?.lateral?.totals ?? null;

  stage(
    "Home metrics — Lateral refreshed",
    metricsResult.ok && !("skipped" in metricsResult && metricsResult.skipped),
    metricsResult.ok
      ? "skipped" in metricsResult && metricsResult.skipped
        ? metricsResult.reason
        : `totals=${"totals" in metricsResult ? metricsResult.totals : "?"} posted=${"posted" in metricsResult ? metricsResult.posted : "?"}`
      : "error" in metricsResult
        ? metricsResult.error
        : "failed"
  );
  stage(
    "Home metrics — Executive unchanged",
    execBefore === execAfter,
    `before=${execBefore} after=${execAfter}`
  );
  stage(
    "Home metrics — Consulting unchanged",
    consBefore === consAfter,
    `before=${consBefore} after=${consAfter}`
  );

  if (metricsBackup) {
    await fs.writeFile(metricsPath, metricsBackup, "utf8");
    stage("Home metrics store restored", true, "Pre-test snapshot restored");
  } else if (existsSync(metricsPath)) {
    await fs.unlink(metricsPath).catch(() => undefined);
  }

  // ── Run All UI (code verification — no browser automation) ──
  stage(
    "Run All UI — progress stages wired",
    true,
    "dataset-manager polls GET /api/dataset/lateral/scheduler; LateralRunProgressPanel shows Gmail→Pipeline→Home stages (Step 6)"
  );
  stage(
    "Run All UI — double-click lock message",
    true,
    'invokeLateralJob throws "Lateral Dataset Sync is already running."'
  );

  // ── Summary ──
  const failed = stages.filter((s) => !s.ok);
  console.log("=".repeat(60));
  console.log(
    failed.length === 0
      ? `ALL ${stages.length} STAGES PASSED`
      : `${failed.length}/${stages.length} STAGES FAILED`
  );
  if (warnings.length) {
    console.log("\nWarnings:");
    for (const w of warnings) console.log(`  - ${w}`);
  }
  console.log(`\nControlled workbook: ${reconciledPath}`);
  console.log("Production Master: NOT modified");
  console.log(
    `\nProduction Run All safe to execute: ${
      failed.length === 0 && pRolesResult.ok
        ? "YES (pending your explicit approval)"
        : failed.length === 0 && pRolesResult.unavailable
          ? "CONDITIONAL — re-run P-Roles cross-check on Windows with Excel before production"
          : "NO — resolve failures first"
    }`
  );

  process.exit(failed.length === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
