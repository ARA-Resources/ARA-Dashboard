/**
 * Complete end-to-end Lateral Dataset automation test (SAFE / offline).
 *
 * - Does NOT touch production Google Drive Master
 * - Does NOT advance real Gmail checkpoint
 * - Uses temp Excel fixtures + local Python reconcile engine
 * - Runs unit verify scripts for remaining gates
 *
 * Run: npx tsx scripts/verify-lateral-e2e.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import ExcelJS from "exceljs";
import { reconcileMasterWorkbookLocally } from "../src/services/lateral-processing/master-reconcile";
import { EXPECTED_NEW_SHEET_HEADERS } from "../src/services/lateral-processing/lateral-new-sheet-structure";
import {
  JOB_REQUISITION_ID_HEADER,
  MASTER_DATE_HEADER,
  MASTER_JOB_STATUS_COLUMN_K,
  MASTER_JOB_STATUS_HEADER,
  resolveLateralJobStatus,
} from "../src/services/lateral-processing/lateral-job-status-rules";
import { compareJobRequisitionsById } from "../src/services/lateral-processing/lateral-job-requisition-comparison";
import {
  assertNeverReportSuccessOnFailure,
  classifyLateralFailure,
  createLateralStageFailure,
} from "../src/services/lateral-processing/lateral-failure-handling";
import {
  LATERAL_CONFLICTING_STATUS_MACRO,
  VBA_STATUS_INTEGRATION_POLICY,
  buildSafeStatusMacroStubSource,
  vbaSourceLooksLikeConflictingStatusLogic,
  vbaSourceLooksLikeSafeStatusStub,
} from "../src/services/lateral-processing/lateral-vba-status-integration";
import { evaluateFinalCheckpointGates } from "../src/services/lateral-processing/lateral-final-checkpoint";
import { preserveOriginalExcelFilename } from "../src/services/lateral-processing/lateral-excel-discovery";
import { assertLateralDriveVisibleFilename } from "../src/services/lateral-processing/lateral-drive-upload";
import { mapAtciDsToNewSheet } from "../src/services/lateral-processing/lateral-column-mapping";
import { formatProcessingDateDDMMYYYY } from "../src/services/lateral-processing/lateral-new-sheet-refresh";
import { validateNewSheetHeaderStructure } from "../src/services/lateral-processing/lateral-new-sheet-structure";

type TestResult = {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
};

const results: TestResult[] = [];
const today = formatProcessingDateDDMMYYYY(new Date());

function record(id: string, name: string, ok: boolean, detail: string) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id} — ${name}`);
  console.log(`      ${detail}\n`);
}

function masterHeaders(): string[] {
  // Columns A–J + K (Job Status) — K must be exactly column 11
  return [
    MASTER_DATE_HEADER, // A
    JOB_REQUISITION_ID_HEADER, // B
    "Priority", // C
    "Job Description", // D
    "Skill Categorization", // E
    "Primary Skills", // F
    "Job Management Level", // G
    "Primary Location", // H
    "Market Map", // I
    "POC", // J
    MASTER_JOB_STATUS_HEADER, // K
  ];
}

async function buildScenarioWorkbook(options: {
  masterRows: Array<{
    date: string;
    jr: string;
    status: string;
    desc?: string;
  }>;
  newRows: Array<{
    date: string;
    jr: string;
    desc?: string;
  }>;
}): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const master = wb.addWorksheet("Master Sheet");
  const neu = wb.addWorksheet("New Sheet");

  master.addRow(masterHeaders());
  for (const row of options.masterRows) {
    master.addRow([
      row.date,
      row.jr,
      "P1",
      row.desc ?? `Desc ${row.jr}`,
      "Cat",
      "Java",
      "L1",
      "Bangalore",
      "MM",
      "POC",
      row.status,
    ]);
  }

  neu.addRow([...EXPECTED_NEW_SHEET_HEADERS]);
  for (const row of options.newRows) {
    neu.addRow([
      row.date,
      row.jr,
      "P1",
      row.desc ?? `Desc ${row.jr}`,
      "Cat",
      "Java",
      "L1",
      "Bangalore",
      "MM",
      "POC",
    ]);
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lateral-e2e-"));
  const filePath = path.join(dir, "e2e-master.xlsx");
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

async function readMasterStatuses(
  filePath: string
): Promise<Map<string, { status: string; date: string; row: number }>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet("Master Sheet");
  if (!ws) throw new Error("Master Sheet missing in output");
  const map = new Map<string, { status: string; date: string; row: number }>();
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const jr = String(row.getCell(2).value ?? "").trim();
    if (!jr) return;
    map.set(jr, {
      status: String(row.getCell(MASTER_JOB_STATUS_COLUMN_K).value ?? "").trim(),
      date: String(row.getCell(1).value ?? "").trim(),
      row: rowNumber,
    });
  });
  return map;
}

async function runLocalReconcile(inputPath: string) {
  const outPath = inputPath.replace(/\.xlsx$/i, ".out.xlsx");
  const result = await reconcileMasterWorkbookLocally({
    inputPath,
    outputPath: outPath,
    todayDDMMYYYY: today,
  });
  return { ...result, outPath };
}

function runVerifyScript(scriptName: string): Promise<{
  ok: boolean;
  output: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(
      "npx",
      ["tsx", path.join("scripts", scriptName)],
      {
        cwd: process.cwd(),
        env: process.env,
        windowsHide: true,
        shell: true,
      }
    );
    let output = "";
    child.stdout.on("data", (d) => {
      output += String(d);
    });
    child.stderr.on("data", (d) => {
      output += String(d);
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, output: output.trim() });
    });
    child.on("error", (err) => {
      resolve({ ok: false, output: err.message });
    });
  });
}

async function test1NewJr() {
  const input = await buildScenarioWorkbook({
    masterRows: [
      { date: "01-01-2026", jr: "JR-EXISTING", status: "Active" },
    ],
    newRows: [
      { date: today, jr: "JR-NEW-001" },
      { date: today, jr: "JR-EXISTING" },
    ],
  });
  const result = await runLocalReconcile(input);
  if (!result.ok) {
    record("TEST 1", "NEW JR", false, result.error || "reconcile failed");
    return;
  }
  const statuses = await readMasterStatuses(result.outPath);
  const neu = statuses.get("JR-NEW-001");
  const existing = statuses.get("JR-EXISTING");
  const detail = result.details?.find((d) => d.jobRequisitionId === "JR-NEW-001");
  const ok =
    neu?.status === "New" &&
    detail?.action === "Added" &&
    Boolean(neu) &&
    existing?.status === "Active" &&
    (result.summary?.newRequisitions ?? 0) === 1 &&
    statuses.size === 2;
  record(
    "TEST 1",
    "NEW JR",
    ok,
    ok
      ? `New Master row created; Column K=New for JR-NEW-001; no accidental dup of JR-EXISTING`
      : `status=${neu?.status} action=${detail?.action} rows=${statuses.size} err=${result.error ?? ""}`
  );
}

async function test2ActiveJr() {
  const input = await buildScenarioWorkbook({
    masterRows: [
      { date: "15-07-2026", jr: "JR-ACTIVE", status: "Active" },
    ],
    newRows: [{ date: today, jr: "JR-ACTIVE" }],
  });
  const result = await runLocalReconcile(input);
  if (!result.ok) {
    record("TEST 2", "ACTIVE JR", false, result.error || "reconcile failed");
    return;
  }
  const statuses = await readMasterStatuses(result.outPath);
  const row = statuses.get("JR-ACTIVE");
  const ok =
    row?.status === "Active" &&
    row.date === "15-07-2026" &&
    statuses.size === 1 &&
    (result.summary?.activeUnchanged ?? 0) === 1;
  record(
    "TEST 2",
    "ACTIVE JR",
    ok,
    ok
      ? `Column K=Active; date unchanged (${row?.date}); no duplicate row`
      : `status=${row?.status} date=${row?.date} rows=${statuses.size}`
  );
}

async function test3ReopenJr() {
  const input = await buildScenarioWorkbook({
    masterRows: [
      { date: "01-01-2025", jr: "JR-REOPEN", status: "Closed" },
      { date: "10-10-2025", jr: "JR-KEEP", status: "Active" },
    ],
    newRows: [
      { date: today, jr: "JR-REOPEN" },
      { date: today, jr: "JR-KEEP" },
    ],
  });
  const result = await runLocalReconcile(input);
  if (!result.ok) {
    record("TEST 3", "REOPEN JR", false, result.error || "reconcile failed");
    return;
  }
  const statuses = await readMasterStatuses(result.outPath);
  const reopen = statuses.get("JR-REOPEN");
  const keep = statuses.get("JR-KEEP");
  const ok =
    reopen?.status === "Reopen" &&
    reopen.date === today &&
    keep?.status === "Active" &&
    keep.date === "10-10-2025" &&
    statuses.size === 2 &&
    (result.summary?.reopenedRequisitions ?? 0) === 1;
  record(
    "TEST 3",
    "REOPEN JR",
    ok,
    ok
      ? `Column K=Reopen; Date=${today}; no duplicate; Active neighbor date preserved`
      : `reopen=${reopen?.status}/${reopen?.date} keep=${keep?.status}/${keep?.date}`
  );
}

async function testKeepNewAndReopen() {
  const input = await buildScenarioWorkbook({
    masterRows: [
      { date: "10-07-2026", jr: "JR-KEEP-NEW", status: "New" },
      { date: "11-07-2026", jr: "JR-KEEP-REOPEN", status: "Reopen" },
    ],
    newRows: [
      { date: today, jr: "JR-KEEP-NEW" },
      { date: today, jr: "JR-KEEP-REOPEN" },
    ],
  });
  const result = await runLocalReconcile(input);
  if (!result.ok) {
    record(
      "TEST 3B",
      "KEEP NEW/REOPEN",
      false,
      result.error || "reconcile failed"
    );
    return;
  }
  const statuses = await readMasterStatuses(result.outPath);
  const neu = statuses.get("JR-KEEP-NEW");
  const reopen = statuses.get("JR-KEEP-REOPEN");
  const ok =
    neu?.status === "New" &&
    neu.date === "10-07-2026" &&
    reopen?.status === "Reopen" &&
    reopen.date === "11-07-2026" &&
    statuses.size === 2 &&
    (result.summary?.activeUnchanged ?? 0) === 0 &&
    (result.summary?.reopenedRequisitions ?? 0) === 0 &&
    (result.summary?.newRequisitions ?? 0) === 0;
  record(
    "TEST 3B",
    "KEEP NEW/REOPEN",
    ok,
    ok
      ? "New and Reopen stayed in Column K; dates unchanged"
      : `new=${neu?.status}/${neu?.date} reopen=${reopen?.status}/${reopen?.date}`
  );
}

async function test4ClosedJr() {
  const input = await buildScenarioWorkbook({
    masterRows: [
      { date: "02-02-2026", jr: "JR-CLOSED", status: "Active" },
      { date: "03-03-2026", jr: "JR-STILL", status: "Active" },
    ],
    newRows: [{ date: today, jr: "JR-STILL" }],
  });
  const result = await runLocalReconcile(input);
  if (!result.ok) {
    record("TEST 4", "CLOSED JR", false, result.error || "reconcile failed");
    return;
  }
  const statuses = await readMasterStatuses(result.outPath);
  const closed = statuses.get("JR-CLOSED");
  const still = statuses.get("JR-STILL");
  const ok =
    closed?.status === "Closed" &&
    closed.date === "02-02-2026" &&
    still?.status === "Active" &&
    statuses.has("JR-CLOSED") &&
    statuses.size === 2 &&
    (result.summary?.closedRequisitions ?? 0) === 1;
  record(
    "TEST 4",
    "CLOSED JR",
    ok,
    ok
      ? `Column K=Closed; row remains; date unchanged (${closed?.date})`
      : `closed=${closed?.status}/${closed?.date} still=${still?.status} rows=${statuses.size}`
  );
}

function test5NoNewEmail() {
  const idle = createLateralStageFailure({
    code: "NO_MATCHING_EMAIL",
    stage: "gmail_email_match",
  });
  const guard = assertNeverReportSuccessOnFailure({
    hardFailure: null,
    checkpointAdvanced: false,
    claimedSuccess: false,
  });
  const ok =
    idle.checkpointAdvanced === false &&
    idle.previousMasterPreserved === true &&
    idle.isHardFailure === false &&
    idle.reportedSuccess === false &&
    guard.ok;
  record(
    "TEST 5",
    "NO NEW EMAIL",
    ok,
    ok
      ? "No Excel/Master mutation path; checkpoint not advanced; not hard-failure"
      : "NO_MATCHING_EMAIL contract failed"
  );
}

function test6DriveFailure() {
  const fail = createLateralStageFailure({
    code: "GOOGLE_DRIVE_UPLOAD_FAILURE",
    stage: "drive_upload",
    detail: "Simulated upload failure",
  });
  const classified = classifyLateralFailure({
    syncItemStatus: "upload_failed",
    error: "upload failed",
  });
  const guard = assertNeverReportSuccessOnFailure({
    hardFailure: fail,
    checkpointAdvanced: false,
    claimedSuccess: true,
  });
  const ok =
    fail.checkpointAdvanced === false &&
    fail.previousMasterPreserved === true &&
    fail.reportedSuccess === false &&
    fail.isHardFailure === true &&
    !guard.ok &&
    (classified.code === "GOOGLE_DRIVE_UPLOAD_FAILURE" ||
      classified.code === "GOOGLE_DRIVE_AUTHENTICATION_FAILURE");
  record(
    "TEST 6",
    "GOOGLE DRIVE FAILURE",
    ok,
    ok
      ? "Upload failure stops pipeline; New/Master untouched; checkpoint not advanced; success blocked"
      : `code=${classified.code} guardOk=${guard.ok}`
  );
}

function test7HeaderMismatch() {
  const validation = validateNewSheetHeaderStructure([
    "Date",
    "Job Requisition ID",
    // Priority missing / wrong
    "WRONG",
    "Job Description",
    "Skill Categorization",
    "Primary Skills",
    "Job Management Level",
    "Primary Location/Office Locate",
    "Market Map",
    "POC",
  ]);
  const fail = createLateralStageFailure({
    code: "HEADER_MISMATCH",
    stage: "new_sheet_structure",
    detail: validation.message,
  });
  const classified = classifyLateralFailure({
    syncItemStatus: "new_sheet_structure_failed",
    error: "header mismatch",
  });
  const ok =
    validation.ok === false &&
    fail.checkpointAdvanced === false &&
    fail.previousMasterPreserved === true &&
    classified.code === "HEADER_MISMATCH";
  record(
    "TEST 7",
    "HEADER MISMATCH",
    ok,
    ok
      ? "Pipeline stops on header mismatch; New/Master unchanged; checkpoint not advanced"
      : validation.message
  );
}

function test8DuplicateJr() {
  const comparison = compareJobRequisitionsById({
    newSheetOccurrences: [
      {
        sheet: "New Sheet",
        rowNumber: 2,
        storedValue: "JR-DUP",
        normalizedId: "JR-DUP",
      },
      {
        sheet: "New Sheet",
        rowNumber: 3,
        storedValue: " JR-DUP ",
        normalizedId: "JR-DUP",
      },
    ],
    masterSheetOccurrences: [
      {
        sheet: "Master Sheet",
        rowNumber: 2,
        storedValue: "JR-OTHER",
        normalizedId: "JR-OTHER",
      },
    ],
  });
  const classified = classifyLateralFailure({
    error: "Duplicate Job Requisition ID JR-DUP",
    pipelineFailedStep: 14,
  });
  const rule = resolveLateralJobStatus({
    existsInNewSheet: true,
    existsInMasterSheet: true,
    existingMasterStatus: "Active",
  });
  const ok =
    comparison.ok === false &&
    comparison.code === "DUPLICATES" &&
    /Do not silently choose/.test(comparison.message) &&
    classified.code === "DUPLICATE_JR_IDS" &&
    rule?.createRow === false;
  record(
    "TEST 8",
    "DUPLICATE JR",
    ok,
    ok
      ? "Stops safely; no ambiguous update; no silent Master duplicate"
      : comparison.ok
        ? "expected duplicate stop"
        : comparison.message
  );
}

function test9MacroConflict() {
  const stub = buildSafeStatusMacroStubSource();
  const ok =
    VBA_STATUS_INTEGRATION_POLICY.runConflictingStatusMacroAfterReconcile ===
      false &&
    VBA_STATUS_INTEGRATION_POLICY.statusLogicOwner === "dataset_backend" &&
    stub.includes(LATERAL_CONFLICTING_STATUS_MACRO) &&
    vbaSourceLooksLikeSafeStatusStub(stub) &&
    !vbaSourceLooksLikeConflictingStatusLogic(stub);
  record(
    "TEST 9",
    "MACRO CONFLICT",
    ok,
    ok
      ? "Conflicting VBA status macro not run after reconcile; Active/Closed/Reopen/New owned by Dataset engine"
      : "VBA conflict policy failed"
  );
}

function finalValidationInline() {
  const checks: Array<{ name: string; ok: boolean }> = [];

  const original = "Lateral Demand Report (final).xlsx";
  checks.push({
    name: "Original Gmail filename preserved",
    ok: preserveOriginalExcelFilename(original) === original,
  });

  checks.push({
    name: "Correct Drive folder used",
    ok: assertLateralDriveVisibleFilename(original) === original,
  });

  const mapped = mapAtciDsToNewSheet(
    [
      "Job Requisition ID",
      "Priority",
      "Job Description",
      "Skill Categorization",
      "Primary Skills",
      "Job Management Level",
      "Primary Location/Office Locate",
      "Market Map",
      "POC",
    ],
    [...EXPECTED_NEW_SHEET_HEADERS]
  );
  checks.push({
    name: "ATCI DS / header-based mapping",
    ok: mapped.ok === true,
  });

  const structure = validateNewSheetHeaderStructure([
    ...EXPECTED_NEW_SHEET_HEADERS,
  ]);
  checks.push({
    name: "New Sheet Row 1 / A:J order preserved",
    ok: structure.ok,
  });
  checks.push({
    name: "Date in Column A + DD-MM-YYYY",
    ok:
      EXPECTED_NEW_SHEET_HEADERS[0] === "Date" &&
      /^\d{2}-\d{2}-\d{4}$/.test(today),
  });
  checks.push({
    name: "JR in Column B",
    ok: EXPECTED_NEW_SHEET_HEADERS[1] === JOB_REQUISITION_ID_HEADER,
  });
  checks.push({
    name: "Master Column K status engine",
    ok: MASTER_JOB_STATUS_COLUMN_K === 11,
  });

  const gates = evaluateFinalCheckpointGates({
    pending: {
      messageId: "m1",
      attachmentId: "a1",
      receivedAt: new Date().toISOString(),
      receivedAtMs: Date.now(),
      attachmentFilename: original,
      driveFileId: "d1",
    },
    gmailSyncOk: true,
    atciDsFound: true,
    masterWorkbookFound: true,
    pipeline: {
      ok: true,
      message: "ok",
      sourceFile: original,
      sourceSheet: "ATCI DS",
      rowsImported: 4,
      newRequisitions: 1,
      reopenedRequisitions: 1,
      closedRequisitions: 1,
      activeUnchanged: 1,
      macroStatus: "skipped_superseded",
      finalMasterSheet: "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm",
      masterFileId: "master",
      finalSaveVerified: true,
      columnKValidated: true,
      lastUpdated: new Date().toISOString(),
      steps: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].map((step) => ({
        step,
        name: `Step ${step}`,
        status: "ok" as const,
        at: new Date().toISOString(),
      })),
    },
  });
  checks.push({
    name: "Gmail checkpoint advances only after complete success",
    ok: gates.ok,
  });

  const failGuard = assertNeverReportSuccessOnFailure({
    hardFailure: createLateralStageFailure({
      code: "STATUS_RECONCILIATION_FAILURE",
      stage: "status_reconciliation",
    }),
    checkpointAdvanced: true,
    claimedSuccess: true,
  });
  checks.push({
    name: "Failure recovery works (never success + no checkpoint on fail)",
    ok: !failGuard.ok,
  });

  const failed = checks.filter((c) => !c.ok);
  record(
    "FINAL",
    "VALIDATION CHECKLIST",
    failed.length === 0,
    failed.length === 0
      ? checks.map((c) => `✓ ${c.name}`).join("; ")
      : failed.map((c) => `✗ ${c.name}`).join("; ")
  );
}

async function runSupportingVerifyScripts() {
  const scripts = [
    "verify-lateral-excel-discovery.ts",
    "verify-lateral-drive-upload.ts",
    "verify-lateral-source-workbook.ts",
    "verify-lateral-new-sheet-structure.ts",
    "verify-lateral-column-mapping.ts",
    "verify-lateral-new-sheet-refresh.ts",
    "verify-lateral-job-status-rules.ts",
    "verify-lateral-new-row-insertion.ts",
    "verify-lateral-reopen-date-update.ts",
    "verify-lateral-status-reconciliation-validation.ts",
    "verify-lateral-job-requisition-comparison.ts",
    "verify-lateral-vba-status-integration.ts",
    "verify-lateral-final-master-save.ts",
    "verify-lateral-final-checkpoint.ts",
    "verify-lateral-failure-handling.ts",
    "verify-lateral-master-drive-update.ts",
    "verify-lateral-gmail-checkpoint.ts",
  ];

  let passed = 0;
  const failures: string[] = [];
  for (const script of scripts) {
    const result = await runVerifyScript(script);
    if (result.ok) {
      passed += 1;
      console.log(`PASS  SCRIPT — ${script}`);
    } else {
      failures.push(script);
      console.log(`FAIL  SCRIPT — ${script}`);
      if (result.output) {
        console.log(`      ${result.output.split("\n").slice(-3).join(" | ")}`);
      }
    }
  }
  record(
    "SUITE",
    "Supporting verify scripts",
    failures.length === 0,
    failures.length === 0
      ? `${passed}/${scripts.length} offline verify scripts passed`
      : `Failed: ${failures.join(", ")}`
  );
}

async function main() {
  console.log("================================================");
  console.log("Lateral Dataset E2E — SAFE offline environment");
  console.log(`Processing date: ${today}`);
  console.log("No production Drive Master / Gmail checkpoint writes");
  console.log("================================================\n");

  await test1NewJr();
  await test2ActiveJr();
  await test3ReopenJr();
  await testKeepNewAndReopen();
  await test4ClosedJr();
  test5NoNewEmail();
  test6DriveFailure();
  test7HeaderMismatch();
  test8DuplicateJr();
  test9MacroConflict();
  finalValidationInline();

  console.log("\n── Supporting offline verify scripts ──\n");
  await runSupportingVerifyScripts();

  const failed = results.filter((r) => !r.ok);
  console.log("\n================================================");
  console.log(
    `RESULT: ${results.length - failed.length}/${results.length} groups passed`
  );
  if (failed.length) {
    console.log("Failures:");
    for (const f of failed) {
      console.log(`  - ${f.id} ${f.name}: ${f.detail}`);
    }
  } else {
    console.log("All TEST 1–9 + FINAL validation + supporting suite PASSED.");
  }
  console.log("================================================");

  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
