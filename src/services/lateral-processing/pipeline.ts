import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildDatasetSaveFilename,
  DATASET_LOG_DIR,
  datasetCurrentDir,
} from "@/services/dataset/paths";
import {
  getDatasetDriveMeta,
  upsertDatasetDriveMeta,
} from "@/services/drive/metadata-store";
import { invalidateDriveFolderStatsCache } from "@/services/drive/folder-stats";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import { readLateralDataForPreview } from "@/services/lateral-processing/data-reader";
import { EXPECTED_NEW_SHEET_HEADERS } from "@/services/lateral-processing/lateral-new-sheet-structure";
import {
  confirmReconciliationSave,
  readReconciliationStaging,
  stageMasterReconciliation,
} from "@/services/lateral-processing/master-reconcile";
import { executeNewSheetUpdate } from "@/services/lateral-processing/new-sheet-writer";
import { LATERAL_STATUS_MACRO } from "@/services/lateral-processing/run-vba-macro";
import { readLateralDataProcessingSetup } from "@/services/lateral-processing/setup-store";
import {
  listExcelWorkbooksInFolder,
  listWorkbookWorksheets,
  resolveProcessingFolderId,
} from "@/services/lateral-processing/setup-validation";
import type { LateralDataProcessingSetup } from "@/types/lateral-processing-setup";
import {
  classifyLateralFailure,
  createLateralStageFailure,
  formatLateralFailureForLog,
} from "@/services/lateral-processing/lateral-failure-handling";
import {
  updateLateralHomeMetricsProgress,
  updateLateralPipelineProgress,
} from "@/services/lateral-processing/lateral-run-progress";

export const PIPELINE_SUCCESS_MESSAGE =
  "Lateral Dataset Sync Completed Successfully" as const;

export const PIPELINE_STEPS = [
  { step: 1, name: "Read Lateral Dataset Configuration" },
  { step: 2, name: "Find latest configured source Excel file in Google Drive" },
  { step: 3, name: "Verify the source workbook exists" },
  { step: 4, name: "Open the configured source worksheet (ATCI DS)" },
  { step: 5, name: "Read the source data" },
  { step: 6, name: "Discover Master Workbook (.xlsm) by exact configured name" },
  { step: 7, name: "Validate Master Sheet and New Sheet exist" },
  { step: 8, name: "Validate New Sheet Row 1 header structure (exact A–J order)" },
  { step: 9, name: "Match source columns to New Sheet headers and validate mapping" },
  { step: 10, name: "Create backup/version of Master Workbook" },
  { step: 11, name: "Clear old New Sheet DATA ONLY (keep Row 1 headers)" },
  { step: 12, name: "Insert ATCI DS data via validated header mapping" },
  { step: 13, name: "Set Column A Date to current processing date (DD-MM-YYYY)" },
  { step: 14, name: "Compare Job Requisition IDs (New Sheet ↔ Master Sheet, no status changes)" },
  {
    step: 15,
    name: "Apply New / Reopen / Closed / Active unchanged rules",
  },
  { step: 16, name: "Generate reconciliation report" },
  { step: 17, name: "Validate everything" },
  {
    step: 18,
    name: "Clean Posted Sheet A/B/C and match Master Sheet Posted (Column M)",
  },
  {
    step: 19,
    name: "Refresh P-Roles PivotTable1 from Master Sheet (Posted filter)",
  },
  { step: 20, name: "Save Master Workbook" },
  { step: 21, name: `Skip conflicting ${LATERAL_STATUS_MACRO} (Dataset owns Column K)` },
  { step: 22, name: "Verify status-safe VBA finalize (stub / no overwrite)" },
  { step: 23, name: "Save final Master Workbook" },
  {
    step: 24,
    name: "Upload/update the final Master Workbook in the configured Google Drive destination",
  },
  { step: 25, name: "Update Dataset Manager" },
] as const;

export type PipelineStepNumber = (typeof PIPELINE_STEPS)[number]["step"];

export interface PipelineStepLog {
  step: number;
  name: string;
  status: "ok" | "failed" | "skipped";
  at: string;
  detail?: string;
}

export interface LateralPipelineSuccess {
  ok: true;
  message: typeof PIPELINE_SUCCESS_MESSAGE;
  sourceFile: string;
  sourceSheet: string;
  rowsImported: number;
  newRequisitions: number;
  reopenedRequisitions: number;
  closedRequisitions: number;
  activeUnchanged: number;
  macroStatus: string;
  finalMasterSheet: string;
  /** Configured Master Workbook Drive file ID (updated in place) */
  masterFileId: string;
  /** Final XLSM save + post-verify completed (false when Postgres-primary soft path skipped XLSM) */
  finalSaveVerified: boolean;
  /** Master Sheet Column K / Postgres job_status sync completed */
  columnKValidated: boolean;
  /** Present when XLSM Drive overwrite was skipped after Postgres Job Status + Posted succeeded */
  xlsmSecondaryWarning?: string;
  lastUpdated: string;
  steps: PipelineStepLog[];
}

export interface LateralPipelineFailure {
  ok: false;
  failedStep: number;
  failedStepName: string;
  reason: string;
  timestamp: string;
  suggestedAction: string;
  errorLogPath: string;
  steps: PipelineStepLog[];
  /** Previous working Master on Drive was not overwritten by a failed final save when possible. */
  previousMasterPreserved: true;
  /** Structured failure — checkpoint must not advance */
  failureCode: string;
  failureStage: string;
  checkpointAdvanced: false;
  reportedSuccess: false;
  retryable: true;
}

export type LateralPipelineResult =
  | LateralPipelineSuccess
  | LateralPipelineFailure;

const SUGGESTED_ACTIONS: Record<number, string> = {
  1: "Open Dataset Manager → Edit Data Processing Setup and save a complete configuration.",
  2: "Confirm the source Drive folder has a demand Excel (with ATCI DS), not only the Master Workbook/backups.",
  3: "Re-check Google Drive access and that the latest source file was not deleted or moved.",
  4: `Confirm the source worksheet is "ATCI DS" and the pipeline is not picking the Master Workbook from the same folder.`,
  5: "Open the source workbook and verify the worksheet has a header row and data.",
  6: "Confirm the master workbook is selected in setup and accessible in Google Drive.",
  7: `Confirm the New Sheet name in setup matches the workbook (default "New Sheet").`,
  8: "Fix New Sheet Row 1 so headers match names/order: Date | Job Requisition ID | Priority | Job Description | Skill Categorization | Primary Skills | Job Management Level | Primary Location/Office Locate | Market Map | POC. Casing may differ (e.g. locate vs Locate). Do not rearrange automatically — correct the workbook manually.",
  9: "Fix missing ATCI DS headers listed in the error (header-name match). Do not rearrange New Sheet columns. Extra ATCI DS columns are ignored and must not be added to New Sheet.",
  10: "Grant Drive permission to create versions/copies, then re-run.",
  11: "Ensure the Master Workbook is not locked in Excel and openpyxl can edit New Sheet.",
  12: "Re-check source data and column mapping, then re-run.",
  13: "Verify Column 1 on New Sheet is the Date column and re-run.",
  14: "Ensure Job Requisition ID exists on New Sheet and Master Sheet, remove duplicate JR IDs, then re-run. Matching is by Job Requisition ID only.",
  15: "Review JR comparison results, then re-run status processing after duplicates are resolved.",
  16: "Re-run the pipeline after confirming Master Sheet and New Sheet are readable.",
  17: "Review validation errors, restore from backup if needed, then re-run.",
  18: "Confirm Posted Sheet exists, Master Sheet has Job Requisition ID and Posted (Column M) headers, then re-run. Column K was not modified by this step.",
  19: "P-Roles refresh failed. On Windows: confirm Excel + pywin32. On Linux/Docker: confirm Python and scripts/_inject-p-roles-google-display.py are present, then re-run. Master Sheet and Column K were not modified by this step.",
  20: "Check Drive write access to the master file, then re-run from Confirm/Save or full pipeline.",
  21: "Status-safe finalize failed. Dataset Column K statuses were already applied; check Drive upload and Excel VBA trust (optional stub). Conflicting status macro is never run.",
  22: "Status-safe VBA finalize verification failed. Confirm .xlsm was re-uploaded and conflicting UpdateJobRequisitionsStatusLateral was not executed.",
  23: "Check Drive upload permissions for the final Master Workbook.",
  24: "Verify the destination folder ID/URL in setup and Drive write access.",
  25: "Check local .data/datasets/current/Lateral write permissions, then re-run step 25.",
};

function stepName(step: number): string {
  return (
    PIPELINE_STEPS.find((s) => s.step === step)?.name ?? `Step ${step}`
  );
}

function mapNewSheetPhaseToStep(phase: string | undefined): number {
  switch (phase) {
    case "header_structure":
      return 8;
    case "backup":
      return 10;
    case "read_source":
      return 5;
    case "column_mapping":
      return 9;
    case "write_new_sheet":
      return 12;
    case "validation":
      return 17;
    case "save_to_drive":
      return 20;
    default:
      return 12;
  }
}

async function appendPipelineLog(entry: Record<string, unknown>): Promise<string> {
  console.info("[lateral-pipeline]", JSON.stringify(entry));
  const day = new Date().toISOString().slice(0, 10);
  const errorLogPath = path.join(DATASET_LOG_DIR, `lateral-pipeline-${day}.jsonl`);
  try {
    await fs.mkdir(DATASET_LOG_DIR, { recursive: true });
    await fs.appendFile(errorLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Non-fatal — file log is supplementary when filesystem is available.
  }
  return errorLogPath;
}

async function verifyDriveFileExists(
  fileId: string
): Promise<{ id: string; name: string } | null> {
  const { drive } = await getAuthorizedGmailClient();
  try {
    const res = await drive.files.get({
      fileId,
      fields: "id,name,trashed",
      supportsAllDrives: true,
    });
    if (res.data.trashed) return null;
    return {
      id: res.data.id ?? fileId,
      name: res.data.name ?? "",
    };
  } catch {
    return null;
  }
}

async function downloadDriveFileToTemp(
  fileId: string,
  fileName: string
): Promise<string> {
  const { drive } = await getAuthorizedGmailClient();
  const safe = (fileName || fileId).replace(/[^\w.-]+/g, "_");
  const tempPath = path.join(
    os.tmpdir(),
    `lateral-pipeline-final-${Date.now()}-${safe}`
  );
  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(tempPath, Buffer.from(response.data as ArrayBuffer));
  return tempPath;
}

function isExcludedSourceWorkbook(options: {
  fileId: string;
  fileName: string;
  masterFileId: string;
}): boolean {
  const { fileId, fileName, masterFileId } = options;
  if (masterFileId && fileId === masterFileId) return true;
  // Backups created by this pipeline in the same folder
  if (/_backup_|_reconcile_backup_/i.test(fileName)) return true;
  // Master Sheet workbooks living in the same Drive folder as demand exports
  if (/mastersheet/i.test(fileName)) return true;
  return false;
}

/**
 * Pick the latest demand/source Excel from the source folder.
 * Never selects the configured Master Workbook or pipeline backups — those often
 * share the same Drive folder and become "latest" after a sync.
 */
async function selectLatestSourceWorkbook(options: {
  folderId: string;
  masterFileId: string;
  sourceWorksheet: string;
}): Promise<{ id: string; name: string; modifiedTime: string | null }> {
  const workbooks = await listExcelWorkbooksInFolder(options.folderId);
  if (workbooks.length === 0) {
    throw new Error("No Excel workbooks found in the configured source folder.");
  }

  const candidates = workbooks.filter(
    (file) =>
      !isExcludedSourceWorkbook({
        fileId: file.id,
        fileName: file.name,
        masterFileId: options.masterFileId,
      })
  );

  if (candidates.length === 0) {
    throw new Error(
      "No demand/source Excel found in the source folder after excluding the Master Workbook and backups. " +
        "Upload an ATCI DS export (e.g. Lateral_*.xlsx) to the source folder."
    );
  }

  const sheetName = options.sourceWorksheet || "ATCI DS";
  const errors: string[] = [];

  // Candidates are already newest-first from listExcelWorkbooksInFolder
  for (const file of candidates) {
    try {
      const sheets = await listWorkbookWorksheets(file.id, file.name);
      if (sheets.includes(sheetName)) {
        return {
          id: file.id,
          name: file.name,
          modifiedTime: file.modifiedTime,
        };
      }
      errors.push(
        `${file.name}: missing "${sheetName}" (has ${sheets.slice(0, 6).join(", ")}${sheets.length > 6 ? "…" : ""})`
      );
    } catch (err) {
      errors.push(
        `${file.name}: ${err instanceof Error ? err.message : "failed to read worksheets"}`
      );
    }
  }

  throw new Error(
    `No source workbook in the folder contains worksheet "${sheetName}". Checked: ${errors.join(" | ")}`
  );
}

/**
 * @deprecated Master destination publish must use
 * updateMasterInDestinationFolderWithoutCreating (files.update on configured ID only).
 * This helper deliberately refuses files.create so a second Master can never be minted.
 */
async function uploadOrUpdateInDestinationFolder(options: {
  localPath: string;
  fileName: string;
  folderId: string;
  preferredFileId?: string;
}): Promise<{ fileId: string; fileName: string }> {
  void options.localPath;
  void options.folderId;
  if (!options.preferredFileId?.trim()) {
    throw new Error(
      "Master Workbook must be updated in place via configured File ID. " +
        "Refusing destination upload without preferredFileId (never create a new Master)."
    );
  }
  const { updateMasterInDestinationFolderWithoutCreating } = await import(
    "@/services/lateral-processing/lateral-master-drive-update"
  );
  const result = await updateMasterInDestinationFolderWithoutCreating({
    localWorkbookPath: options.localPath,
    fileName: options.fileName,
    folderId: options.folderId,
    masterFileId: options.preferredFileId,
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return { fileId: result.fileId, fileName: result.fileName };
}

async function updateDatasetManagerCurrent(options: {
  localPath: string;
  fileName: string;
  driveFileId: string;
  folderId: string;
}): Promise<{ filePath: string; fileName: string; fileSize: number }> {
  const datasetName = "Lateral";
  const currentDir = datasetCurrentDir(datasetName);
  await fs.mkdir(currentDir, { recursive: true });

  const savedName = buildDatasetSaveFilename(options.fileName);
  const nextCurrent = path.join(currentDir, savedName);
  await fs.copyFile(options.localPath, nextCurrent);

  const existing = await fs.readdir(currentDir);
  for (const file of existing) {
    if (file !== savedName && /\.(xlsx|xlsm|xls)$/i.test(file)) {
      await fs.unlink(path.join(currentDir, file)).catch(() => undefined);
    }
  }

  const stat = await fs.stat(nextCurrent);
  const prev = await getDatasetDriveMeta(datasetName);
  await upsertDatasetDriveMeta({
    datasetName,
    driveFileId: options.driveFileId,
    fileName: savedName,
    uploadTime: new Date().toISOString(),
    fileSize: stat.size,
    versionNumber: (prev?.versionNumber ?? 0) + 1,
    folderId: options.folderId,
  });
  invalidateDriveFolderStatsCache();

  return {
    filePath: nextCurrent,
    fileName: savedName,
    fileSize: stat.size,
  };
}

/**
 * End-to-end Lateral Dataset Processing Pipeline (steps 1–25).
 * Reuses existing New Sheet writer, reconciliation, and VBA runner — does not rewrite them.
 * On any failure: stops immediately, writes an error log, and does not report success.
 */
export async function runLateralDatasetPipeline(): Promise<LateralPipelineResult> {
  const steps: PipelineStepLog[] = [];
  const startedAt = new Date().toISOString();

  const markOk = (step: number, detail?: string) => {
    updateLateralPipelineProgress(step, "ok", detail);
    const next = PIPELINE_STEPS.find((s) => s.step === step + 1);
    if (next) updateLateralPipelineProgress(next.step, "active");
    steps.push({
      step,
      name: stepName(step),
      status: "ok",
      at: new Date().toISOString(),
      detail,
    });
  };

  const fail = async (
    step: number,
    reason: string,
    suggestedAction?: string
  ): Promise<LateralPipelineFailure> => {
    updateLateralPipelineProgress(step, "failed", reason);
    const timestamp = new Date().toISOString();
    const classified = classifyLateralFailure({
      error: reason,
      pipelineFailedStep: step,
    });
    const stageFailure = createLateralStageFailure({
      code: classified.code,
      stage: classified.stage,
      detail: reason,
      messageOverride: reason,
    });
    steps.push({
      step,
      name: stepName(step),
      status: "failed",
      at: timestamp,
      detail: reason,
    });
    const errorLogPath = await appendPipelineLog({
      level: "error",
      event: "lateral_pipeline_failed",
      failedStep: step,
      failedStepName: stepName(step),
      reason,
      timestamp,
      suggestedAction:
        suggestedAction ?? SUGGESTED_ACTIONS[step] ?? "Re-run after fixing the issue.",
      startedAt,
      steps,
      ...formatLateralFailureForLog(stageFailure),
      checkpointAdvanced: false,
      previousMasterPreserved: true,
      reportedSuccess: false,
      retryable: true,
    });
    return {
      ok: false,
      failedStep: step,
      failedStepName: stepName(step),
      reason,
      timestamp,
      suggestedAction:
        suggestedAction ?? SUGGESTED_ACTIONS[step] ?? "Re-run after fixing the issue.",
      errorLogPath,
      steps,
      previousMasterPreserved: true,
      failureCode: stageFailure.code,
      failureStage: stageFailure.failedStage,
      checkpointAdvanced: false,
      reportedSuccess: false,
      retryable: true,
    };
  };

  updateLateralPipelineProgress(1, "active");

  // ── STEP 1 ───────────────────────────────────────────────────────────────
  let setup: LateralDataProcessingSetup | null = null;
  try {
    setup = await readLateralDataProcessingSetup();
  } catch (err) {
    return fail(
      1,
      err instanceof Error ? err.message : "Failed to read Lateral Dataset Configuration."
    );
  }
  if (!setup) {
    return fail(
      1,
      "Lateral Data Processing Setup is not configured."
    );
  }
  if (!setup.masterWorkbook.fileId) {
    return fail(1, "Master workbook is not selected in configuration.");
  }
  const { resolvePipelineMasterWorkbook } = await import(
    "@/types/lateral-processing-setup"
  );
  const pipelineMaster = resolvePipelineMasterWorkbook(setup);
  markOk(1, `dataset=${setup.datasetName}`);

  // ── STEP 2 ───────────────────────────────────────────────────────────────
  const sourceFolderId = resolveProcessingFolderId(setup.sourceFolder);
  if (!sourceFolderId) {
    return fail(2, "Source folder is not configured (folder ID/URL missing).");
  }

  let latestSource: { id: string; name: string; modifiedTime: string | null };
  try {
    latestSource = await selectLatestSourceWorkbook({
      folderId: sourceFolderId,
      masterFileId: pipelineMaster.fileId,
      sourceWorksheet: setup.sourceWorksheet || "ATCI DS",
    });
  } catch (err) {
    return fail(
      2,
      err instanceof Error
        ? err.message
        : "Failed to list Excel files in the source Drive folder."
    );
  }
  markOk(
    2,
    `${latestSource.name}${latestSource.modifiedTime ? ` (${latestSource.modifiedTime})` : ""}`
  );

  const runSetup: LateralDataProcessingSetup = {
    ...setup,
    sourceWorkbook: {
      fileId: latestSource.id,
      fileName: latestSource.name,
    },
    sourceWorksheet: setup.sourceWorksheet || "ATCI DS",
    // Pipeline mutates the XLSM processing master (not the Google Sheet primary).
    masterWorkbook: {
      fileId: pipelineMaster.fileId,
      fileName: pipelineMaster.fileName,
    },
    masterNewSheet: setup.masterNewSheet || "New Sheet",
    masterSheet: setup.masterSheet || "Master Sheet",
  };

  // ── STEP 3 ───────────────────────────────────────────────────────────────
  const sourceMeta = await verifyDriveFileExists(runSetup.sourceWorkbook.fileId);
  if (!sourceMeta) {
    return fail(
      3,
      `Source workbook does not exist or is trashed: ${runSetup.sourceWorkbook.fileName}`
    );
  }
  markOk(3, sourceMeta.name || runSetup.sourceWorkbook.fileName);

  // ── STEPS 4–9 (worksheet open + read + header mapping) ───────────────────
  let sourceSheets: string[] = [];
  try {
    sourceSheets = await listWorkbookWorksheets(
      runSetup.sourceWorkbook.fileId,
      runSetup.sourceWorkbook.fileName
    );
  } catch (err) {
    return fail(
      4,
      err instanceof Error
        ? err.message
        : "Failed to open the source workbook worksheets."
    );
  }
  if (!sourceSheets.includes(runSetup.sourceWorksheet)) {
    return fail(
      4,
      runSetup.sourceWorksheet === "ATCI DS"
        ? "ATCI DS worksheet was not found."
        : `Source worksheet "${runSetup.sourceWorksheet}" not found. Available: ${sourceSheets.join(", ") || "(none)"}`
    );
  }
  markOk(4, runSetup.sourceWorksheet);

  // ── STEPS 6–7: Master Workbook discovery (exact XLSM + Master Sheet + New Sheet)
  let masterDiscovery;
  try {
    const { discoverLateralMasterWorkbook } = await import(
      "@/services/lateral-processing/lateral-master-workbook-discovery"
    );
    masterDiscovery = await discoverLateralMasterWorkbook({ setup: runSetup });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Master Workbook discovery failed.";
    // Sheet missing → step 7; otherwise step 6
    const sheetMissing = /worksheet was not found/i.test(message);
    return fail(sheetMissing ? 7 : 6, message);
  }
  markOk(6, masterDiscovery.fileName);

  const { validatePipelineRequiredWorksheets } = await import(
    "@/services/lateral-processing/lateral-master-workbook-discovery"
  );
  const requiredSheets = validatePipelineRequiredWorksheets({
    availableWorksheets: masterDiscovery.availableWorksheets,
  });
  if (!requiredSheets.ok) {
    return fail(
      7,
      `Required worksheets missing from Master Workbook: ${requiredSheets.missing.join(", ")}. Available: ${masterDiscovery.availableWorksheets.join(", ") || "(none)"}`
    );
  }
  markOk(
    7,
    `${masterDiscovery.masterSheet} + ${masterDiscovery.newSheet} + ${requiredSheets.postedSheet} + ${requiredSheets.pRolesSheet}`
  );

  // Keep runSetup.masterWorkbook aligned with discovered identity (never rename).
  runSetup.masterWorkbook = {
    fileId: masterDiscovery.fileId,
    fileName: masterDiscovery.fileName,
  };
  runSetup.masterSheet = masterDiscovery.masterSheet;
  runSetup.masterNewSheet = masterDiscovery.newSheet;

  // ── STEP 8: New Sheet structure (exact A–J headers) — before any changes ─
  try {
    const { assertNewSheetStructureFromDrive } = await import(
      "@/services/lateral-processing/lateral-new-sheet-structure"
    );
    const structure = await assertNewSheetStructureFromDrive({
      masterFileId: runSetup.masterWorkbook.fileId,
      masterFileName: runSetup.masterWorkbook.fileName,
      newSheetName: runSetup.masterNewSheet,
    });
    markOk(8, structure.expectedHeaders.join(" | "));
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "New Sheet header structure validation failed.";
    return fail(8, message, SUGGESTED_ACTIONS[8]);
  }

  let preview;
  try {
    preview = await readLateralDataForPreview(runSetup);
  } catch (err) {
    return fail(
      5,
      err instanceof Error ? err.message : "Failed to read source data."
    );
  }

  if (!preview.ok) {
    return fail(
      9,
      preview.message ||
        [
          "ATCI DS → New Sheet column mapping failed. Pipeline stopped.",
          `Missing header: ${preview.missingDestinationHeaders.join(", ")}`,
          `Source headers found: ${preview.availableSourceHeaders.join(" | ") || "(none)"}`,
          `Destination headers expected: ${EXPECTED_NEW_SHEET_HEADERS.join(" | ")}`,
        ].join("\n"),
      SUGGESTED_ACTIONS[9]
    );
  }
  if (preview.source.rowCount < 0) {
    return fail(5, "Source data read returned an invalid row count.");
  }
  markOk(5, `${preview.source.rowCount} data row(s)`);
  markOk(
    9,
    `${preview.columnMappings.length} column(s) matched; mapping validated`
  );

  // ── STEPS 10–13 (existing New Sheet writer — staged local only) ──────────
  let newSheetResult;
  let stagedNewSheetPath: string | null = null;
  try {
    newSheetResult = await executeNewSheetUpdate(runSetup, {
      commitToProduction: false,
    });
  } catch (err) {
    return fail(
      10,
      err instanceof Error
        ? err.message
        : "Unexpected error during New Sheet update."
    );
  }
  if (!newSheetResult.ok) {
    const step = mapNewSheetPhaseToStep(newSheetResult.phase);
    const reason = newSheetResult.error || "New Sheet update failed.";
    const suggested =
      /Cannot read properties of undefined \(reading 'name'\)|Failed to read New Sheet headers/i.test(
        reason
      )
        ? "Master .xlsm could not be read by ExcelJS. Restart the app if needed, then re-run — New Sheet reads now use openpyxl."
        : SUGGESTED_ACTIONS[step];
    return fail(step, reason, suggested);
  }
  markOk(10, newSheetResult.backupFileName);
  markOk(11, "New Sheet data rows cleared; Row 1 headers retained");
  markOk(12, `${newSheetResult.rowsWritten} row(s) inserted (= source count)`);
  markOk(
    13,
    `Column A Date = processing date ${newSheetResult.processingDate} (DD-MM-YYYY)`
  );
  stagedNewSheetPath = newSheetResult.localEditedPath || null;
  if (!stagedNewSheetPath) {
    return fail(
      12,
      "New Sheet update did not return a staged local workbook. Production Master was not committed."
    );
  }
  if (newSheetResult.committedToProduction) {
    return fail(
      12,
      "New Sheet update committed to production before P-Roles validation. Pipeline aborted."
    );
  }

  try {
  // Intermediate Drive save after New Sheet is deferred. Downstream steps use
  // the staged local XLSM. Production identity is updated only by confirmReconciliationSave.

  // ── STEP 14: JR comparison engine (no status changes yet) ────────────────
  let jrComparison;
  try {
    const { compareJobRequisitionsFromLocalMaster } = await import(
      "@/services/lateral-processing/lateral-job-requisition-comparison"
    );
    jrComparison = await compareJobRequisitionsFromLocalMaster({
      localPath: stagedNewSheetPath,
      masterSheetName: runSetup.masterSheet,
      newSheetName: runSetup.masterNewSheet,
    });
  } catch (err) {
    return fail(
      14,
      err instanceof Error
        ? err.message
        : "Unexpected error during Job Requisition ID comparison."
    );
  }
  if (!jrComparison.ok) {
    return fail(14, jrComparison.message, SUGGESTED_ACTIONS[14]);
  }
  markOk(14, jrComparison.summaryMessage);

  // ── STEPS 15–16 (status processing / staged reconciliation) ──────────────
  let reconcileResult;
  try {
    reconcileResult = await stageMasterReconciliation(runSetup, {
      localWorkbookPath: stagedNewSheetPath,
    });
  } catch (err) {
    return fail(
      15,
      err instanceof Error
        ? err.message
        : "Unexpected error during Job Requisition reconciliation."
    );
  }
  if (!reconcileResult.ok) {
    return fail(
      15,
      reconcileResult.error || "Reconciliation failed."
    );
  }
  markOk(
    15,
    `New=${reconcileResult.report.summary.newRequisitions}, Reopen=${reconcileResult.report.summary.reopenedRequisitions}, Closed=${reconcileResult.report.summary.closedRequisitions}, Active=${reconcileResult.report.summary.activeUnchanged}`
  );
  markOk(
    16,
    `Report generated at ${reconcileResult.report.generatedAt}`
  );

  // ── STEP 17 ──────────────────────────────────────────────────────────────
  const summary = reconcileResult.report.summary;
  if (
    typeof summary.newRequisitions !== "number" ||
    typeof summary.reopenedRequisitions !== "number" ||
    typeof summary.closedRequisitions !== "number" ||
    typeof summary.activeUnchanged !== "number"
  ) {
    return fail(17, "Reconciliation report summary is incomplete.");
  }
  if (!newSheetResult.validationPassed) {
    return fail(17, "New Sheet validation did not pass.");
  }
  markOk(17, "New Sheet + reconciliation report validated");

  // ── Postgres Job Status authority (New Sheet ↔ lateral_master) ────────────
  // Dashboard Master Sheet reads Postgres. Excel Column K above remains for
  // XLSM workbook compatibility only — not the status source of truth.
  try {
    const { reconcileLateralMasterJobStatusFromNewSheet } = await import(
      "@/services/lateral-processing/lateral-master-job-status-sync"
    );
    const { parseExcelDateToIso } = await import(
      "@/services/lateral-processing/lateral-master-pg-backfill"
    );
    const processingDateParsed = parseExcelDateToIso(
      newSheetResult.processingDate
    );
    const pgStatus = await reconcileLateralMasterJobStatusFromNewSheet({
      localWorkbookPath:
        (await readReconciliationStaging())?.stagedFilePath ||
        stagedNewSheetPath,
      newSheetName: runSetup.masterNewSheet,
      processingDateIso: processingDateParsed.ok
        ? processingDateParsed.iso || undefined
        : undefined,
    });
    if (!pgStatus.ok) {
      return fail(
        15,
        pgStatus.error ||
          "Postgres Job Status reconciliation failed. Checkpoint will not advance."
      );
    }
    markOk(
      15,
      `Postgres lateral_master job_status: New=${pgStatus.counts.added}, Reopen=${pgStatus.counts.reopened}, Closed=${pgStatus.counts.closed}, Active=${pgStatus.counts.activated}, Unchanged=${pgStatus.counts.unchanged} (authority=Postgres; XLSM Column K updated for compatibility)`
    );
  } catch (err) {
    return fail(
      15,
      err instanceof Error
        ? err.message
        : "Unexpected error during Postgres Job Status reconciliation."
    );
  }

  // ── STEP 18: Posted Sheet A/B/C + Master Column M matching ──
  // A = cleaned posting text, B = JR ID, C = Demand Yes/No.
  // Matching authority: PostgreSQL lateral_master.posted (primary).
  // Excel Column M is still written for XLSM compatibility after PG sync.
  // Runs on the staged local XLSM after Column K / Postgres status and before
  // confirmReconciliationSave(). Does not write Column K / Job Status.
  // TODO(next phase): migrate P-Roles (step 19) to Postgres-backed feeds;
  // leave XLSM/Google P-Roles pivot behavior unchanged until then.
  try {
    const { applyPostedSheetMatchingToStagedWorkbook } = await import(
      "@/services/lateral-processing/lateral-posted-sheet-processor"
    );
    const staging = await readReconciliationStaging();
    if (!staging?.stagedFilePath) {
      return fail(
        18,
        "Posted matching could not find the staged Master Workbook. Column M was not changed. Column K was not modified."
      );
    }
    const postedResult = await applyPostedSheetMatchingToStagedWorkbook({
      localWorkbookPath: staging.stagedFilePath,
      masterSheetName: runSetup.masterSheet,
    });
    if (!postedResult.ok) {
      // Hard-fail only when Postgres posted sync did not complete.
      // XLSM Column M is secondary; PG-primary soft failures return ok:true
      // with xlsmMirrorWarning from the processor.
      return fail(18, postedResult.error, SUGGESTED_ACTIONS[18]);
    }
    const xlsmNote = postedResult.xlsmMirrorWarning
      ? ` WARNING (XLSM secondary mirror): ${postedResult.xlsmMirrorWarning}`
      : "";
    markOk(
      18,
      `Posted Sheet A/B/C (Postgres primary): cleaned=${postedResult.counts.validAtciRows}/${postedResult.counts.postedSheetRowsRead}; ` +
        `Demand Yes=${postedResult.counts.demandYesCount} No=${postedResult.counts.demandNoCount}; ` +
        `Master posted Yes=${postedResult.counts.masterRowsMarkedYes}; ` +
        `matched JRs=${postedResult.counts.matchingJrs}; ` +
        `Posted-only JRs=${postedResult.counts.nonMatchingPostedJrs}; ` +
        `Column K unchanged` +
        xlsmNote
    );
  } catch (err) {
    return fail(
      18,
      err instanceof Error
        ? err.message
        : "Unexpected error during Posted Sheet matching. Column M was not changed. Column K was not modified.",
      SUGGESTED_ACTIONS[18]
    );
  }

  // ── STEP 19: Refresh P-Roles PivotTable1 (Master Sheet → Posted filter) ──
  // Runs on staged XLSM after Posted Column M update. Does not modify Master Sheet.
  // TODO(next phase): migrate P-Roles openings/pivot to Postgres `lateral_master`
  // after New Sheet + job_status + posted PG path is proven. Do not change here.
  try {
    const stagingForPRoles = await readReconciliationStaging();
    if (!stagingForPRoles?.stagedFilePath) {
      return fail(
        19,
        "P-Roles refresh could not find the staged Master Workbook. The existing PivotTable was not modified."
      );
    }
    const { refreshPRolesPivotOnStagedWorkbook } = await import(
      "@/services/lateral-processing/lateral-p-roles-pivot-refresh"
    );
    const pRolesResult = await refreshPRolesPivotOnStagedWorkbook({
      localWorkbookPath: stagingForPRoles.stagedFilePath,
    });
    if (!pRolesResult.ok) {
      return fail(19, pRolesResult.error, SUGGESTED_ACTIONS[19]);
    }
    markOk(
      19,
      `P-Roles pivot "${pRolesResult.pivotName}" refreshed; source=${pRolesResult.sourceA1}; Posted items=[${pRolesResult.postedFilterItems.join(", ")}]; ` +
        `Master Posted Yes=${pRolesResult.postedYesCount} Dash=${pRolesResult.postedDashCount}; ` +
        `JML order ok=${pRolesResult.jmlOrderOk}; Column K unchanged`
    );
  } catch (err) {
    return fail(
      19,
      err instanceof Error
        ? err.message
        : "Unexpected error during P-Roles PivotTable refresh. Master Sheet and Column K were not modified.",
      SUGGESTED_ACTIONS[19]
    );
  }

  // ── STEPS 20–23 (existing confirm + VBA + final upload) ──────────────────
  let confirmResult;
  try {
    confirmResult = await confirmReconciliationSave();
  } catch (err) {
    return fail(
      20,
      err instanceof Error
        ? err.message
        : "Unexpected error while saving Master Workbook / running macro."
    );
  }
  if (!confirmResult.ok) {
    // Postgres Job Status + Posted already applied (steps 15 PG + 18).
    // XLSM final-save validation (e.g. Reopen Column A dates) is secondary —
    // do not hard-fail the whole Run All as if Postgres never updated.
    if (confirmResult.phase === "validation") {
      const xlsmWarning =
        confirmResult.error || "Final Master XLSM save validation failed.";
      markOk(
        20,
        `WARNING (XLSM secondary): ${xlsmWarning} Postgres lateral_master Job Status + Posted already updated; Drive XLSM overwrite skipped.`
      );
      markOk(21, "Skipped VBA finalize — XLSM not overwritten");
      markOk(22, "Skipped status-safe finalize (Postgres primary)");
      markOk(23, "XLSM final save skipped after validation warning");
      markOk(24, "Drive destination upload skipped (XLSM validation warning)");
      markOk(
        25,
        "Dataset Manager XLSM promote skipped; dashboard Master Sheet reads Postgres"
      );

      const staging = await readReconciliationStaging().catch(() => null);
      const lastUpdated = new Date().toISOString();
      const success: LateralPipelineSuccess = {
        ok: true,
        message: PIPELINE_SUCCESS_MESSAGE,
        sourceFile: runSetup.sourceWorkbook.fileName,
        sourceSheet: runSetup.sourceWorksheet,
        rowsImported: newSheetResult.rowsWritten,
        newRequisitions: summary.newRequisitions,
        reopenedRequisitions: summary.reopenedRequisitions,
        closedRequisitions: summary.closedRequisitions,
        activeUnchanged: summary.activeUnchanged,
        macroStatus: "skipped_xlsm_secondary_validation",
        finalMasterSheet:
          staging?.masterFileName || runSetup.masterWorkbook.fileName,
        masterFileId: staging?.masterFileId || runSetup.masterWorkbook.fileId,
        finalSaveVerified: false,
        columnKValidated: true,
        xlsmSecondaryWarning: xlsmWarning,
        lastUpdated,
        steps,
      };

      await appendPipelineLog({
        level: "info",
        event: "lateral_pipeline_success_postgres_primary",
        timestamp: lastUpdated,
        startedAt,
        xlsmSecondaryWarning: xlsmWarning,
        ...success,
      });

      // Home KPIs: refresh from Postgres (XLSM promote skipped on this path).
      try {
        updateLateralHomeMetricsProgress("active");
        const { refreshLateralHomeWidgetsMetricsFromPostgres } = await import(
          "@/services/home/refresh-lateral-home-widgets-metrics"
        );
        const metricsResult =
          await refreshLateralHomeWidgetsMetricsFromPostgres({
            computedAt: lastUpdated,
          });
        if (metricsResult.ok && !metricsResult.skipped) {
          updateLateralHomeMetricsProgress("ok");
        } else if (metricsResult.ok && metricsResult.skipped) {
          updateLateralHomeMetricsProgress("skipped", metricsResult.reason);
        } else if (!metricsResult.ok) {
          updateLateralHomeMetricsProgress("failed", metricsResult.error);
        }
      } catch (metricsErr) {
        updateLateralHomeMetricsProgress(
          "failed",
          metricsErr instanceof Error ? metricsErr.message : String(metricsErr)
        );
      }

      return success;
    }
    if (confirmResult.phase === "backup") {
      return fail(
        20,
        confirmResult.error || "Backup before final save failed.",
        "Ensure Drive write access for backups, then re-run."
      );
    }
    if (confirmResult.phase === "macro") {
      markOk(20, "Pre-save validation passed");
      if (confirmResult.macro) {
        markOk(21, confirmResult.macro.macroName);
        return fail(
          22,
          confirmResult.error ||
            confirmResult.macro.errorMessage ||
            "Status-safe finalize verification failed.",
          SUGGESTED_ACTIONS[22]
        );
      }
      return fail(
        21,
        confirmResult.error || `Failed to finalize ${LATERAL_STATUS_MACRO}.`
      );
    }
    return fail(
      20,
      confirmResult.error || "Failed to save Master Workbook."
    );
  }

  markOk(
    20,
    `Final XLSM saved (${confirmResult.masterFileName})` +
      (confirmResult.backupFileName
        ? `; backup ${confirmResult.backupFileName}`
        : "")
  );
  markOk(
    21,
    `${confirmResult.macro.macroName}: ${confirmResult.macro.result}` +
      (confirmResult.macro.conflictingMacroNeutralized
        ? " (Module11 safe stub applied)"
        : " (conflicting status logic not executed)")
  );
  const macroOk =
    confirmResult.macro.ok &&
    (confirmResult.macro.result === "success" ||
      confirmResult.macro.result === "skipped_superseded");
  if (!macroOk) {
    return fail(
      22,
      confirmResult.macro.errorMessage ||
        "Status-safe VBA finalize did not complete successfully.",
      SUGGESTED_ACTIONS[22]
    );
  }
  markOk(
    22,
    `Status-safe finalize OK (${confirmResult.macro.durationMs}ms)` +
      (confirmResult.macro.neutralizationNote
        ? ` — ${confirmResult.macro.neutralizationNote}`
        : "")
  );
  markOk(23, "Final Master Workbook saved (Dataset status; XLSM preserved)");

  // ── STEP 24 ──────────────────────────────────────────────────────────────
  const destinationFolderId = resolveProcessingFolderId(
    runSetup.destinationFolder
  );
  if (!destinationFolderId) {
    return fail(
      24,
      "Destination folder is not configured (folder ID/URL missing)."
    );
  }

  let finalLocalPath: string | null = null;
  let destinationFileId = confirmResult.masterFileId;
  try {
    finalLocalPath = await downloadDriveFileToTemp(
      confirmResult.masterFileId,
      confirmResult.masterFileName
    );
    const { updateMasterInDestinationFolderWithoutCreating } = await import(
      "@/services/lateral-processing/lateral-master-drive-update"
    );
    const dest = await updateMasterInDestinationFolderWithoutCreating({
      localWorkbookPath: finalLocalPath,
      fileName: confirmResult.masterFileName,
      folderId: destinationFolderId,
      masterFileId: confirmResult.masterFileId,
    });
    if (!dest.ok) {
      return fail(24, dest.error);
    }
    destinationFileId = dest.fileId;
    markOk(
      24,
      dest.createdNewFile === false
        ? `${dest.fileName} updated in place (no new Master created)`
        : `${dest.fileName} → destination folder`
    );
  } catch (err) {
    if (finalLocalPath) {
      await fs.unlink(finalLocalPath).catch(() => undefined);
    }
    return fail(
      24,
      err instanceof Error
        ? err.message
        : "Failed to update Master Workbook at configured/destination location."
    );
  }

  // ── STEP 25 ──────────────────────────────────────────────────────────────
  /** Dataset Manager path of the FINAL Master — used for Home metrics (Phase 3). */
  let promotedMasterPath: string | null = null;
  try {
    const promoted = await updateDatasetManagerCurrent({
      localPath: finalLocalPath!,
      fileName: confirmResult.masterFileName,
      driveFileId: destinationFileId,
      folderId: destinationFolderId,
    });
    promotedMasterPath = promoted.filePath;
    markOk(25, promoted.filePath);
  } catch (err) {
    await fs.unlink(finalLocalPath!).catch(() => undefined);
    return fail(
      25,
      err instanceof Error
        ? err.message
        : "Failed to update Dataset Manager current Lateral workbook."
    );
  } finally {
    if (finalLocalPath) {
      await fs.unlink(finalLocalPath).catch(() => undefined);
    }
  }

  const lastUpdated = confirmResult.updatedAt || new Date().toISOString();
  if (!confirmResult.finalSaveVerified) {
    return fail(
      23,
      "Final XLSM Master save was not verified — refusing pipeline success."
    );
  }
  if (!confirmResult.finalSaveValidation?.ok) {
    return fail(
      23,
      confirmResult.finalSaveValidation?.reasons?.join(" ") ||
        "Final Master save validation missing — Column K / New Sheet / Master Sheet not confirmed."
    );
  }

  const success: LateralPipelineSuccess = {
    ok: true,
    message: PIPELINE_SUCCESS_MESSAGE,
    sourceFile: runSetup.sourceWorkbook.fileName,
    sourceSheet: runSetup.sourceWorksheet,
    rowsImported: newSheetResult.rowsWritten,
    newRequisitions: summary.newRequisitions,
    reopenedRequisitions: summary.reopenedRequisitions,
    closedRequisitions: summary.closedRequisitions,
    activeUnchanged: summary.activeUnchanged,
    macroStatus: `${confirmResult.macro.macroName}: ${confirmResult.macro.result}`,
    finalMasterSheet: confirmResult.masterFileName,
    masterFileId: confirmResult.masterFileId,
    finalSaveVerified: true,
    columnKValidated: true,
    lastUpdated,
    steps,
  };

  await appendPipelineLog({
    level: "info",
    event: "lateral_pipeline_success",
    timestamp: lastUpdated,
    startedAt,
    ...success,
  });

  // ── Home widgets metrics (Phase 3) — AFTER confirmed pipeline success only.
  // Secondary: failure here must NOT change pipeline success / Dataset outcome.
  if (promotedMasterPath) {
    try {
      updateLateralHomeMetricsProgress("active");
      const { refreshLateralHomeWidgetsMetricsFromFinalMaster } = await import(
        "@/services/home/refresh-lateral-home-widgets-metrics"
      );
      const metricsResult = await refreshLateralHomeWidgetsMetricsFromFinalMaster(
        {
          filePath: promotedMasterPath,
          fileName: confirmResult.masterFileName,
          masterSheetName: runSetup.masterSheet,
          computedAt: lastUpdated,
        }
      );
      if (metricsResult.ok && metricsResult.skipped) {
        updateLateralHomeMetricsProgress("skipped", metricsResult.reason);
        console.info(
          `[home-widgets-metrics] ${metricsResult.reason}`
        );
      } else if (metricsResult.ok) {
        updateLateralHomeMetricsProgress("ok");
        console.info(
          `[home-widgets-metrics] Lateral snapshot updated totals=${metricsResult.totals} active=${metricsResult.active} posted=${metricsResult.posted} fresh=${metricsResult.fresh} rows=${metricsResult.rowCount}`
        );
        await appendPipelineLog({
          level: "info",
          event: "home_widgets_metrics_updated",
          timestamp: new Date().toISOString(),
          totals: metricsResult.totals,
          active: metricsResult.active,
          posted: metricsResult.posted,
          fresh: metricsResult.fresh,
          rowCount: metricsResult.rowCount,
        });
      } else {
        updateLateralHomeMetricsProgress("failed", metricsResult.error);
        console.warn(
          `[home-widgets-metrics] Lateral snapshot update failed (pipeline still success): ${metricsResult.error}`
        );
        await appendPipelineLog({
          level: "warn",
          event: "home_widgets_metrics_failed",
          timestamp: new Date().toISOString(),
          error: metricsResult.error,
        });
      }
    } catch (metricsError) {
      updateLateralHomeMetricsProgress(
        "failed",
        metricsError instanceof Error ? metricsError.message : "Unexpected Home metrics error"
      );
      console.warn(
        "[home-widgets-metrics] Unexpected error refreshing Lateral Home metrics (pipeline still success)",
        metricsError
      );
      await appendPipelineLog({
        level: "warn",
        event: "home_widgets_metrics_failed",
        timestamp: new Date().toISOString(),
        error:
          metricsError instanceof Error
            ? metricsError.message
            : "Unexpected Home metrics error",
      }).catch(() => undefined);
    }
  }

  // When dashboard Master Sheet is Postgres-backed, keep home_metrics aligned
  // with lateral_master (authoritative for /home KPIs).
  try {
    const { isPostgresMode } = await import("@/lib/persistence/persistence-mode");
    if (isPostgresMode()) {
      const { refreshLateralHomeWidgetsMetricsFromPostgres } = await import(
        "@/services/home/refresh-lateral-home-widgets-metrics"
      );
      const pgMetrics = await refreshLateralHomeWidgetsMetricsFromPostgres({
        computedAt: lastUpdated,
      });
      if (pgMetrics.ok && !pgMetrics.skipped) {
        updateLateralHomeMetricsProgress("ok");
      }
    }
  } catch {
    // Secondary — pipeline success already decided.
  }

  return success;
  } finally {
    if (stagedNewSheetPath) {
      await fs.unlink(stagedNewSheetPath).catch(() => undefined);
    }
  }
}
