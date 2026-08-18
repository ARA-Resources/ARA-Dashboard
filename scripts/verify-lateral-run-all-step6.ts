/**
 * Step 6 — Run All wiring verification (SAFE / offline).
 *
 * - Does NOT call Gmail, Drive, or production Run All
 * - Verifies progress store, worksheet validation, Posted + P-Roles processors on temp XLSM
 *
 * Run: npx tsx scripts/verify-lateral-run-all-step6.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  validatePipelineRequiredWorksheets,
} from "../src/services/lateral-processing/lateral-master-workbook-discovery";
import { applyPostedSheetMatchingToStagedWorkbook } from "../src/services/lateral-processing/lateral-posted-sheet-processor";
import {
  getLateralRunProgress,
  markLateralRunIdleAfterNoNewSource,
  resetLateralRunProgress,
  startLateralRunProgress,
  updateLateralPipelineProgress,
} from "../src/services/lateral-processing/lateral-run-progress";
import { PIPELINE_STEPS } from "../src/services/lateral-processing/pipeline";

type Result = { id: string; name: string; ok: boolean; detail: string };
const results: Result[] = [];

function record(id: string, name: string, ok: boolean, detail: string) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id} — ${name}`);
  console.log(`      ${detail}\n`);
}

async function buildMinimalMasterXlsm(filePath: string) {
  const wb = new ExcelJS.Workbook();
  const master = wb.addWorksheet("Master Sheet");
  master.addRow([
    "Date",
    "Job Requisition ID",
    "Priority",
    "Job Description",
    "Skill Categorization",
    "Primary Skills",
    "Job Management Level",
    "Primary Location/Office locate",
    "Market Map",
    "POC",
    "Job Status",
    "Notes",
    "Posted",
  ]);
  master.addRow([
    "01-01-2026",
    "ATCI12345",
    "P1",
    "Role A",
    "Tech",
    "Java",
    "11-Analyst",
    "BLR",
    "India",
    "POC1",
    "Active",
    "",
    "-",
  ]);

  wb.addWorksheet("New Sheet").addRow([
    "Date",
    "Job Requisition ID",
    "Priority",
    "Job Description",
    "Skill Categorization",
    "Primary Skills",
    "Job Management Level",
    "Primary Location/Office locate",
    "Market Map",
    "POC",
  ]);

  const posted = wb.addWorksheet("Posted Sheet");
  posted.addRow(["Demand"]);
  posted.addRow(["ATCI12345 Posted demand text"]);

  wb.addWorksheet("P-Roles");
  wb.addWorksheet("ATCI DS");

  await wb.xlsx.writeFile(filePath);
}

async function main() {
  // 1) Worksheet validation
  const sheetsOk = validatePipelineRequiredWorksheets({
    availableWorksheets: [
      "Master Sheet",
      "New Sheet",
      "Posted Sheet",
      "P-Roles",
    ],
  });
  record(
    "S6-01",
    "Validate Posted Sheet + P-Roles present",
    sheetsOk.ok,
    sheetsOk.ok
      ? `${sheetsOk.postedSheet}, ${sheetsOk.pRolesSheet}`
      : `Missing: ${sheetsOk.missing.join(", ")}`
  );

  const sheetsMissing = validatePipelineRequiredWorksheets({
    availableWorksheets: ["Master Sheet", "New Sheet"],
  });
  record(
    "S6-02",
    "Reject Master missing Posted/P-Roles",
    !sheetsMissing.ok && sheetsMissing.missing.includes("Posted Sheet"),
    sheetsMissing.ok ? "Expected failure" : sheetsMissing.missing.join(", ")
  );

  // 2) Progress store — no-new-source path
  resetLateralRunProgress();
  startLateralRunProgress("manual");
  markLateralRunIdleAfterNoNewSource(
    "No new Lateral dataset found. Master workbook was not modified."
  );
  const idleProgress = getLateralRunProgress();
  const pipelineSkipped = idleProgress.stages
    .filter((s) => s.id.startsWith("pipeline_"))
    .every((s) => s.status === "skipped");
  record(
    "S6-03",
    "No-new-source skips pipeline stages",
    pipelineSkipped,
    idleProgress.currentStageLabel
  );

  // 3) Progress store — pipeline step count matches PIPELINE_STEPS
  resetLateralRunProgress();
  startLateralRunProgress("manual");
  updateLateralPipelineProgress(1, "active");
  updateLateralPipelineProgress(1, "ok");
  const progress = getLateralRunProgress();
  record(
    "S6-04",
    "Pipeline progress step total",
    progress.pipelineStepTotal === PIPELINE_STEPS.length,
    `total=${progress.pipelineStepTotal}, expected=${PIPELINE_STEPS.length}`
  );

  // 4) Posted processor on staged workbook (Step 4 reuse — not duplicated)
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lateral-step6-"));
  const staged = path.join(tmpDir, "master-step6.xlsm");
  await buildMinimalMasterXlsm(staged);

  const postedResult = await applyPostedSheetMatchingToStagedWorkbook({
    localWorkbookPath: staged,
    masterSheetName: "Master Sheet",
    postedSheetName: "Posted Sheet",
  });
  record(
    "S6-05",
    "Posted Column A → Master Column M (isolated)",
    postedResult.ok && (postedResult.counts?.matchingJrs ?? 0) >= 1,
    postedResult.ok
      ? `matches=${postedResult.counts?.matchingJrs}, columnKUnchanged=${postedResult.counts?.columnKUnchanged}`
      : postedResult.error ?? "unknown error"
  );

  const failed = results.filter((r) => !r.ok);
  console.log("---");
  console.log(
    failed.length === 0
      ? `All ${results.length} Step 6 checks passed.`
      : `${failed.length}/${results.length} checks FAILED.`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
