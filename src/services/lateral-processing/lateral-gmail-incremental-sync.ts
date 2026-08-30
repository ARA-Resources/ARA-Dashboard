import fs from "node:fs/promises";
import path from "node:path";
import { clearSkillClusterCache } from "@/services/excel/extract-skill-clusters";
import { clearExcelCache } from "@/services/excel/reader";
import {
  DATASET_LOG_DIR,
  DATASET_TEMP_DIR,
  datasetCurrentDir,
  datasetVersionsDir,
  sanitizeDatasetName,
} from "@/services/dataset/paths";
import { readDatasetSetup } from "@/services/dataset/secure-store";
import { validateExcelBuffer } from "@/services/dataset/validate-excel";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import {
  getCalendarDateInTimezone,
  getStartOfCalendarDayMs,
} from "@/services/gmail/query";
import {
  LateralDriveUploadError,
  uploadLateralExcelToDrive,
} from "@/services/lateral-processing/lateral-drive-upload";
import {
  buildLateralExcelDiscoveryQuery,
  discoverLateralExcelInMessage,
  originalExcelFilenameForDrive,
  preserveOriginalExcelFilename,
  sortLateralDiscoveriesChronologically,
  type LateralDiscoveredEmail,
} from "@/services/lateral-processing/lateral-excel-discovery";
import {
  isAfterLateralGmailCheckpoint,
  readLateralGmailCheckpoint,
} from "@/services/lateral-processing/lateral-gmail-checkpoint-store";
import {
  ATCI_DS_WORKSHEET_NOT_FOUND,
  LateralSourceWorkbookError,
  processLateralSourceWorkbook,
  type LateralSourceWorkbookRead,
} from "@/services/lateral-processing/lateral-source-workbook";
import {
  discoverLateralMasterWorkbook,
  LateralMasterDiscoveryError,
  type LateralMasterDiscoveryResult,
} from "@/services/lateral-processing/lateral-master-workbook-discovery";
import { readLateralDataProcessingSetup } from "@/services/lateral-processing/setup-store";
import { DEFAULT_FILE_TYPES } from "@/types/dataset-setup";
import { DEFAULT_LATERAL_SOURCE_WORKSHEET } from "@/types/lateral-processing-setup";
import type { LateralGmailCheckpoint } from "@/types/lateral-gmail-checkpoint";

const MAX_MESSAGES = 100;

export interface LateralIncrementalSyncItem {
  messageId: string;
  attachmentId: string;
  attachmentName: string;
  receivedAt: string;
  receivedAtMs: number;
  /** Display-only email metadata (never tokens) */
  sender?: string;
  subject?: string;
  status:
    | "uploaded_drive"
    | "download_failed"
    | "validation_failed"
    | "upload_failed"
    | "source_sheet_missing"
    | "source_read_failed"
    | "master_discovery_failed"
    | "new_sheet_structure_failed"
    | "skipped";
  driveFileId?: string | null;
  error?: string;
  selectionReason?: string;
  sourceWorksheet?: string;
  sourceRowCount?: number;
  sourceColCount?: number;
  masterFileId?: string;
  masterFileName?: string;
}

export interface LateralPendingCheckpointAdvance {
  messageId: string;
  attachmentId: string;
  receivedAt: string;
  receivedAtMs: number;
  attachmentFilename: string;
  driveFileId: string;
  /**
   * Local temp path of the downloaded workbook (Phase 3A staging handoff).
   * Present after successful download + ATCI DS read.
   */
  localWorkbookPath?: string;
  /** Display-only (no tokens) */
  sender?: string;
  subject?: string;
}

/** full_pipeline = Run All path; staging_only = Phase 3A (skip Master/New Sheet). */
export type LateralGmailSyncPurpose = "full_pipeline" | "staging_only";

export interface LateralGmailIncrementalSyncOptions {
  purpose?: LateralGmailSyncPurpose;
  /**
   * Cap how many matched emails to download/upload in this run.
   * When set with processNewestFirst, newest emails are preferred.
   */
  maxUploads?: number;
  /** Prefer newest-first queue order (default chronological oldest-first). */
  processNewestFirst?: boolean;
}

export interface LateralIncrementalSyncResult {
  checkpointBefore: LateralGmailCheckpoint;
  checkpointAfter: LateralGmailCheckpoint;
  query: string;
  /** Enabled Lateral keyword values used to build the Gmail search */
  gmailKeywords: string[];
  syncPurpose: LateralGmailSyncPurpose;
  scannedMessages: number;
  matchedAttachments: number;
  processedCount: number;
  uploadedCount: number;
  failedCount: number;
  /** True when a failure stopped the run before later emails were processed */
  stoppedOnFailure: boolean;
  items: LateralIncrementalSyncItem[];
  warnings: string[];
  message: string;
  /**
   * Checkpoint is NOT advanced here.
   * - full_pipeline: advance only after Master Drive update (executeLateralDatasetJob)
   * - staging_only: advance only after lateral_staging import succeeds
   */
  pendingCheckpointAdvances: LateralPendingCheckpointAdvance[];
  /** Last successful source workbook read in this run (if any) */
  lastSourceRead?: Pick<
    LateralSourceWorkbookRead,
    "worksheetName" | "rowCount" | "colCount" | "headers" | "workbookFileName"
  > | null;
  /** Last successful Master Workbook discovery in this run (if any) */
  lastMasterDiscovery?: Pick<
    LateralMasterDiscoveryResult,
    "fileId" | "fileName" | "masterSheet" | "newSheet"
  > | null;
}

async function appendLog(entry: Record<string, unknown>) {
  console.info("[lateral-gmail-sync]", JSON.stringify(entry));
  try {
    await fs.mkdir(DATASET_LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(DATASET_LOG_DIR, `lateral-gmail-${day}.jsonl`);
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Non-fatal — file log is supplementary when filesystem is available.
  }
}

/**
 * Lateral-only incremental Gmail sync with Excel discovery.
 *
 * - Searches with configured Lateral keywords (no hardcoded sender)
 * - Matches subject, body, and attachment filename
 * - Excel only: .xlsx / .xlsm / .xls
 * - Multiple attachments → explicit Lateral criteria selection (logged)
 * - Multiple emails → chronological order (oldest first)
 * - Preserves ORIGINAL attachment filename (never renames)
 * - Does NOT advance Gmail checkpoint here
 * - purpose=full_pipeline: Master/New Sheet gates; checkpoint after Master save
 * - purpose=staging_only: skips Master/New Sheet; checkpoint after staging import
 */
export async function runLateralGmailIncrementalSync(
  options?: LateralGmailIncrementalSyncOptions
): Promise<LateralIncrementalSyncResult> {
  const syncPurpose: LateralGmailSyncPurpose =
    options?.purpose ?? "full_pipeline";

  const setup = await readDatasetSetup();
  if (!setup) {
    throw new Error("Complete Dataset setup before Lateral Gmail sync.");
  }

  const lateral = setup.datasets?.Lateral;
  if (!lateral || lateral.enabled === false) {
    throw new Error("Lateral dataset is disabled in Dataset setup.");
  }

  const checkpointBefore = await readLateralGmailCheckpoint();
  const warnings: string[] = [];
  const items: LateralIncrementalSyncItem[] = [];
  const pendingCheckpointAdvances: LateralPendingCheckpointAdvance[] = [];
  let lastSourceRead: LateralIncrementalSyncResult["lastSourceRead"] = null;
  let lastMasterDiscovery: LateralIncrementalSyncResult["lastMasterDiscovery"] =
    null;

  const processingSetup = await readLateralDataProcessingSetup();
  const sourceWorksheetName =
    processingSetup?.sourceWorksheet?.trim() || DEFAULT_LATERAL_SOURCE_WORKSHEET;

  const gmailKeywords = (lateral.keywords ?? [])
    .filter((k) => k.enabled !== false && String(k.value ?? "").trim())
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    .map((k) => String(k.value).trim());

  const afterMs =
    checkpointBefore.receivedAtMs ??
    getStartOfCalendarDayMs(getCalendarDateInTimezone());

  if (!checkpointBefore.messageId || checkpointBefore.receivedAtMs == null) {
    warnings.push(
      `No Lateral Gmail checkpoint yet — searching from start of today (${getCalendarDateInTimezone()}).`
    );
  }

  // Gmail after: can be fuzzy; query slightly before cursor then filter strictly.
  const queryAfterMs = Math.max(0, afterMs - 2000);
  const fileTypes =
    lateral.fileTypes?.length > 0 ? lateral.fileTypes : DEFAULT_FILE_TYPES;
  const query = buildLateralExcelDiscoveryQuery({
    afterMs: queryAfterMs,
    keywords: lateral.keywords,
    fileTypes,
  });

  const { gmail, drive, auth } = await getAuthorizedGmailClient();

  if (
    setup.gmailAddress &&
    auth.email &&
    setup.gmailAddress.toLowerCase() !== auth.email.toLowerCase()
  ) {
    warnings.push(
      `Connected mailbox (${auth.email}) differs from setup Gmail (${setup.gmailAddress}).`
    );
  }

  await appendLog({
    at: new Date().toISOString(),
    event: "lateral_excel_discovery_start",
    query,
    syncPurpose,
    gmailKeywords,
    checkpointMessageId: checkpointBefore.messageId,
    checkpointReceivedAtMs: checkpointBefore.receivedAtMs,
    keywordCount: gmailKeywords.length,
  });

  const list = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: MAX_MESSAGES,
  });
  const messageRefs = list.data.messages ?? [];

  const discoveries: LateralDiscoveredEmail[] = [];
  for (const ref of messageRefs) {
    if (!ref.id) continue;
    const full = await gmail.users.messages.get({
      userId: "me",
      id: ref.id,
      format: "full",
    });

    const discovered = discoverLateralExcelInMessage(full.data, {
      keywords: lateral.keywords,
      fileTypes,
    });
    if (!discovered) continue;

    const selected = discovered.selection.selected;
    if (
      !isAfterLateralGmailCheckpoint(
        {
          messageId: selected.messageId,
          attachmentId: selected.attachmentId,
          receivedAtMs: selected.receivedAtMs,
        },
        checkpointBefore
      )
    ) {
      continue;
    }

    discoveries.push(discovered);
    await appendLog({
      at: new Date().toISOString(),
      event: "lateral_excel_discovered",
      messageId: discovered.messageId,
      subject: discovered.subject,
      sender: discovered.sender,
      receivedAt: discovered.receivedAt,
      attachmentFilename: selected.attachmentName,
      attachmentId: selected.attachmentId,
      matchedKeyword: selected.matchedKeyword?.keyword ?? null,
      matchedIn: selected.matchedKeyword?.matchedIn ?? null,
      selectionReason: discovered.selection.selectionReason,
      rejectedAttachments: discovered.selection.rejectedAttachments,
    });
  }

  // Chronological unless configuration later specifies another order.
  let queue = sortLateralDiscoveriesChronologically(discoveries);
  if (options?.processNewestFirst) {
    queue = [...queue].reverse();
  }
  if (
    typeof options?.maxUploads === "number" &&
    options.maxUploads > 0 &&
    queue.length > options.maxUploads
  ) {
    warnings.push(
      `Limiting Gmail uploads to newest/first ${options.maxUploads} of ${queue.length} matched email(s).`
    );
    queue = queue.slice(0, options.maxUploads);
  }

  let checkpointAfter = checkpointBefore;
  let uploadedCount = 0;
  let failedCount = 0;
  let stoppedOnFailure = false;
  let processedCount = 0;

  await fs.mkdir(DATASET_TEMP_DIR, { recursive: true });

  for (const discovery of queue) {
    const row = discovery.selection.selected;
    processedCount += 1;

    const originalFilename = originalExcelFilenameForDrive(row.attachmentName);
    const savedName = preserveOriginalExcelFilename(originalFilename);

    await appendLog({
      at: new Date().toISOString(),
      event: "lateral_excel_selected_for_processing",
      messageId: discovery.messageId,
      subject: discovery.subject,
      sender: discovery.sender,
      attachmentFilename: originalFilename,
      preservedFilename: savedName,
      attachmentId: row.attachmentId,
      receivedAtMs: row.receivedAtMs,
      selectionReason: discovery.selection.selectionReason,
      rejectedAttachments: discovery.selection.rejectedAttachments,
      queuePosition: processedCount,
      queueSize: queue.length,
    });

    const tempDir = path.join(DATASET_TEMP_DIR, sanitizeDatasetName("Lateral"));
    await fs.mkdir(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, savedName);

    try {
      const attachment = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: row.messageId,
        id: row.attachmentId,
      });
      const data = attachment.data.data;
      if (!data) {
        throw new Error("Gmail returned an empty attachment body.");
      }
      const buffer = Buffer.from(data, "base64url");
      await fs.writeFile(tempPath, buffer);

      const integrity = await validateExcelBuffer(buffer, originalFilename);
      if (!integrity.ok) {
        failedCount += 1;
        stoppedOnFailure = true;
        items.push({
          messageId: row.messageId,
          attachmentId: row.attachmentId,
          attachmentName: originalFilename,
          receivedAt: row.receivedAt,
          receivedAtMs: row.receivedAtMs,
          status: "validation_failed",
          error: integrity.error ?? "Excel validation failed.",
          selectionReason: discovery.selection.selectionReason,
        });
        await appendLog({
          at: new Date().toISOString(),
          event: "lateral_gmail_validation_failed",
          messageId: row.messageId,
          attachmentName: originalFilename,
          error: integrity.error,
        });
        // Do NOT advance checkpoint — retry this email next run.
        break;
      }

      // Lateral Drive upload stage (COMMON Google Drive connection).
      // Verify success before checkpoint / Master Workbook work.
      let driveFileId: string;
      try {
        await appendLog({
          at: new Date().toISOString(),
          event: "lateral_drive_upload_start",
          messageId: row.messageId,
          originalFilename,
          fileSize: buffer.length,
        });

        const upload = await uploadLateralExcelToDrive({
          localPath: tempPath,
          originalFilename,
          fileSize: buffer.length,
          drive,
          setup,
          // Previous SOURCE File ID from last successful processing checkpoint.
          // Used only after new upload verifies — never delete-before-upload.
          previousSourceDriveFileId: checkpointBefore.driveFileId,
          messageId: row.messageId,
          receivedAt: row.receivedAt,
          configuredMasterFileId:
            processingSetup?.masterWorkbook?.fileId ?? null,
          configuredMasterFileName:
            processingSetup?.masterWorkbook?.fileName ?? null,
        });

        driveFileId = upload.meta.driveFileId;

        await appendLog({
          at: new Date().toISOString(),
          event: "lateral_drive_upload_verified",
          messageId: row.messageId,
          originalFilename,
          visibleFileName: upload.verification.visibleFileName,
          driveFileId,
          folderId: upload.verification.folderId,
          folderName: upload.verification.folderName,
          folderPathHint: upload.folderPathHint,
          replacedExisting: upload.replacedExisting,
          size: upload.verification.size,
          previousDeletedFileIds: upload.cleanup.deletedFileIds,
          pendingCleanupFileIds: upload.cleanup.pendingCleanupFileIds,
          cleanupPartial: upload.cleanup.partial,
          cleanupNotes: upload.cleanup.notes,
        });

        if (upload.cleanup.partial) {
          warnings.push(
            `Lateral Drive source cleanup partial for "${originalFilename}": new file ${driveFileId} verified; previous source delete will retry next run.`
          );
        }
      } catch (uploadError) {
        failedCount += 1;
        stoppedOnFailure = true;
        const message =
          uploadError instanceof LateralDriveUploadError
            ? uploadError.message
            : uploadError instanceof Error
              ? uploadError.message
              : "Lateral Google Drive upload failed.";
        items.push({
          messageId: row.messageId,
          attachmentId: row.attachmentId,
          attachmentName: originalFilename,
          receivedAt: row.receivedAt,
          receivedAtMs: row.receivedAtMs,
          status: "upload_failed",
          error: message,
          driveFileId: null,
          selectionReason: discovery.selection.selectionReason,
        });
        await appendLog({
          at: new Date().toISOString(),
          event: "lateral_drive_upload_failed",
          messageId: row.messageId,
          attachmentName: originalFilename,
          error: message,
          code:
            uploadError instanceof LateralDriveUploadError
              ? uploadError.code
              : "UPLOAD_FAILED",
        });
        // STOP — Do NOT advance checkpoint. Do NOT continue to Master Workbook.
        break;
      }

      // Source workbook processing (read-only): find ATCI DS by exact name.
      let sourceRead: LateralSourceWorkbookRead;
      try {
        await appendLog({
          at: new Date().toISOString(),
          event: "lateral_source_workbook_open",
          messageId: row.messageId,
          originalFilename,
          driveFileId,
          worksheetName: sourceWorksheetName,
        });

        sourceRead = await processLateralSourceWorkbook({
          localPath: tempPath,
          worksheetName: sourceWorksheetName,
          workbookFileName: originalFilename,
        });

        lastSourceRead = {
          worksheetName: sourceRead.worksheetName,
          rowCount: sourceRead.rowCount,
          colCount: sourceRead.colCount,
          headers: sourceRead.headers,
          workbookFileName: sourceRead.workbookFileName,
        };

        await appendLog({
          at: new Date().toISOString(),
          event: "lateral_source_workbook_read",
          messageId: row.messageId,
          originalFilename,
          driveFileId,
          worksheetName: sourceRead.worksheetName,
          availableWorksheets: sourceRead.availableWorksheets,
          headerRowNumber: sourceRead.headerRowNumber,
          headers: sourceRead.headers,
          rowCount: sourceRead.rowCount,
          colCount: sourceRead.colCount,
          // Do not log every cell — row count is enough for ops; preview first few.
          dataRowPreview: sourceRead.dataRows.slice(0, 5),
        });
      } catch (sourceError) {
        failedCount += 1;
        stoppedOnFailure = true;
        const missing =
          sourceError instanceof LateralSourceWorkbookError &&
          sourceError.code === "WORKSHEET_NOT_FOUND";
        const message =
          sourceError instanceof LateralSourceWorkbookError
            ? sourceError.message
            : sourceError instanceof Error
              ? sourceError.message
              : ATCI_DS_WORKSHEET_NOT_FOUND;

        items.push({
          messageId: row.messageId,
          attachmentId: row.attachmentId,
          attachmentName: originalFilename,
          receivedAt: row.receivedAt,
          receivedAtMs: row.receivedAtMs,
          status: missing ? "source_sheet_missing" : "source_read_failed",
          error: message,
          driveFileId,
          selectionReason: discovery.selection.selectionReason,
          sourceWorksheet: sourceWorksheetName,
        });
        await appendLog({
          at: new Date().toISOString(),
          event: missing
            ? "lateral_source_worksheet_missing"
            : "lateral_source_workbook_read_failed",
          messageId: row.messageId,
          attachmentName: originalFilename,
          driveFileId,
          worksheetName: sourceWorksheetName,
          error: message,
          availableWorksheets:
            sourceError instanceof LateralSourceWorkbookError
              ? sourceError.availableWorksheets
              : [],
        });
        // STOP — Do NOT advance checkpoint. Do NOT modify Master Workbook.
        break;
      }

      // Master Workbook discovery (read-only): exact XLSM + Master Sheet + New Sheet.
      // Required for full_pipeline before checkpoint. Skipped for staging_only (Phase 3A).
      let masterDiscovery: LateralMasterDiscoveryResult | null = null;
      if (syncPurpose === "staging_only") {
        await appendLog({
          at: new Date().toISOString(),
          event: "lateral_staging_only_skip_master_discovery",
          messageId: row.messageId,
          reason:
            "Phase 3A staging import does not touch Master Workbook / New Sheet.",
        });
      } else if (!processingSetup) {
        warnings.push(
          "Lateral Dataset Setup not configured — skipped Master Workbook discovery."
        );
      } else {
        try {
          await appendLog({
            at: new Date().toISOString(),
            event: "lateral_master_discovery_start",
            messageId: row.messageId,
            expectedMasterFileName:
              processingSetup.masterWorkbook.fileName ?? null,
          });

          masterDiscovery = await discoverLateralMasterWorkbook({
            setup: processingSetup,
            drive,
          });

          lastMasterDiscovery = {
            fileId: masterDiscovery.fileId,
            fileName: masterDiscovery.fileName,
            masterSheet: masterDiscovery.masterSheet,
            newSheet: masterDiscovery.newSheet,
          };

          await appendLog({
            at: new Date().toISOString(),
            event: "lateral_master_discovery_ok",
            messageId: row.messageId,
            masterFileId: masterDiscovery.fileId,
            masterFileName: masterDiscovery.fileName,
            masterSheet: masterDiscovery.masterSheet,
            newSheet: masterDiscovery.newSheet,
            availableWorksheets: masterDiscovery.availableWorksheets,
            folderId: masterDiscovery.folderId,
          });

          // New Sheet structure must match exact A–J headers before checkpoint / writes.
          const { assertNewSheetStructureFromDrive, LateralNewSheetStructureError } =
            await import(
              "@/services/lateral-processing/lateral-new-sheet-structure"
            );
          try {
            const structure = await assertNewSheetStructureFromDrive({
              masterFileId: masterDiscovery.fileId,
              masterFileName: masterDiscovery.fileName,
              newSheetName: masterDiscovery.newSheet,
            });
            await appendLog({
              at: new Date().toISOString(),
              event: "lateral_new_sheet_structure_ok",
              messageId: row.messageId,
              expectedHeaders: structure.expectedHeaders,
              actualHeaders: structure.actualHeaders,
            });
          } catch (structureError) {
            failedCount += 1;
            stoppedOnFailure = true;
            const message =
              structureError instanceof LateralNewSheetStructureError
                ? structureError.message
                : structureError instanceof Error
                  ? structureError.message
                  : "New Sheet header structure validation failed.";
            items.push({
              messageId: row.messageId,
              attachmentId: row.attachmentId,
              attachmentName: originalFilename,
              receivedAt: row.receivedAt,
              receivedAtMs: row.receivedAtMs,
              status: "new_sheet_structure_failed",
              error: message,
              driveFileId,
              selectionReason: discovery.selection.selectionReason,
              sourceWorksheet: sourceRead.worksheetName,
              sourceRowCount: sourceRead.rowCount,
              sourceColCount: sourceRead.colCount,
              masterFileId: masterDiscovery.fileId,
              masterFileName: masterDiscovery.fileName,
            });
            await appendLog({
              at: new Date().toISOString(),
              event: "lateral_new_sheet_structure_failed",
              messageId: row.messageId,
              error: message,
              differences:
                structureError instanceof LateralNewSheetStructureError
                  ? structureError.validation.differences
                  : null,
              expectedHeaders:
                structureError instanceof LateralNewSheetStructureError
                  ? structureError.validation.expectedHeaders
                  : null,
              actualHeaders:
                structureError instanceof LateralNewSheetStructureError
                  ? structureError.validation.actualHeaders
                  : null,
            });
            // STOP — Do NOT advance checkpoint. Do NOT modify Master Workbook.
            break;
          }
        } catch (masterError) {
          failedCount += 1;
          stoppedOnFailure = true;
          const message =
            masterError instanceof LateralMasterDiscoveryError
              ? masterError.message
              : masterError instanceof Error
                ? masterError.message
                : "Master Workbook discovery failed.";

          items.push({
            messageId: row.messageId,
            attachmentId: row.attachmentId,
            attachmentName: originalFilename,
            receivedAt: row.receivedAt,
            receivedAtMs: row.receivedAtMs,
            status: "master_discovery_failed",
            error: message,
            driveFileId,
            selectionReason: discovery.selection.selectionReason,
            sourceWorksheet: sourceRead.worksheetName,
            sourceRowCount: sourceRead.rowCount,
            sourceColCount: sourceRead.colCount,
          });
          await appendLog({
            at: new Date().toISOString(),
            event: "lateral_master_discovery_failed",
            messageId: row.messageId,
            attachmentName: originalFilename,
            driveFileId,
            error: message,
            code:
              masterError instanceof LateralMasterDiscoveryError
                ? masterError.code
                : "VERIFY_FAILED",
            details:
              masterError instanceof LateralMasterDiscoveryError
                ? masterError.details ?? null
                : null,
          });
          // STOP — Do NOT advance checkpoint. Do NOT modify Master Workbook.
          break;
        }
      }

      // Promote to Dataset Manager current (same as shared sync path).
      if (setup.fileReplacePolicy !== "keep_old") {
        const currentDir = datasetCurrentDir("Lateral");
        await fs.mkdir(currentDir, { recursive: true });
        if (setup.fileReplacePolicy === "version_history") {
          const versionsDir = datasetVersionsDir("Lateral");
          await fs.mkdir(versionsDir, { recursive: true });
          const existing = await fs.readdir(currentDir).catch(() => []);
          for (const file of existing) {
            await fs
              .copyFile(
                path.join(currentDir, file),
                path.join(versionsDir, file)
              )
              .catch(() => undefined);
          }
        }
        const nextCurrent = path.join(currentDir, savedName);
        await fs.copyFile(tempPath, nextCurrent);
        const existing = await fs.readdir(currentDir);
        for (const file of existing) {
          if (file !== savedName) {
            await fs.unlink(path.join(currentDir, file)).catch(() => undefined);
          }
        }
      }

      // Defer checkpoint until downstream processing succeeds
      // (Master Drive save for full_pipeline; staging import for staging_only).
      pendingCheckpointAdvances.push({
        messageId: row.messageId,
        attachmentId: row.attachmentId,
        receivedAt: row.receivedAt,
        receivedAtMs: row.receivedAtMs,
        attachmentFilename: originalFilename,
        driveFileId,
        localWorkbookPath: tempPath,
        sender: discovery.sender,
        subject: discovery.subject,
      });
      uploadedCount += 1;
      items.push({
        messageId: row.messageId,
        attachmentId: row.attachmentId,
        attachmentName: originalFilename,
        receivedAt: row.receivedAt,
        receivedAtMs: row.receivedAtMs,
        sender: discovery.sender,
        subject: discovery.subject,
        status: "uploaded_drive",
        driveFileId,
        selectionReason: discovery.selection.selectionReason,
        sourceWorksheet: sourceRead.worksheetName,
        sourceRowCount: sourceRead.rowCount,
        sourceColCount: sourceRead.colCount,
        masterFileId: masterDiscovery?.fileId,
        masterFileName: masterDiscovery?.fileName,
      });
      await appendLog({
        at: new Date().toISOString(),
        event:
          syncPurpose === "staging_only"
            ? "lateral_gmail_uploaded_pending_staging_import"
            : "lateral_gmail_uploaded_pending_master_save",
        messageId: row.messageId,
        subject: discovery.subject,
        attachmentFilename: originalFilename,
        preservedFilename: originalFilename,
        driveFileId,
        localWorkbookPath: tempPath,
        receivedAtMs: row.receivedAtMs,
        selectionReason: discovery.selection.selectionReason,
        sourceWorksheet: sourceRead.worksheetName,
        sourceRowCount: sourceRead.rowCount,
        sourceColCount: sourceRead.colCount,
        masterFileId: masterDiscovery?.fileId ?? null,
        masterFileName: masterDiscovery?.fileName ?? null,
        masterSheet: masterDiscovery?.masterSheet ?? null,
        newSheet: masterDiscovery?.newSheet ?? null,
        checkpointDeferred: true,
        syncPurpose,
      });
    } catch (error) {
      failedCount += 1;
      stoppedOnFailure = true;
      const message =
        error instanceof Error ? error.message : "Attachment download failed.";
      items.push({
        messageId: row.messageId,
        attachmentId: row.attachmentId,
        attachmentName: originalFilename,
        receivedAt: row.receivedAt,
        receivedAtMs: row.receivedAtMs,
        status: "download_failed",
        error: message,
        selectionReason: discovery.selection.selectionReason,
      });
      await appendLog({
        at: new Date().toISOString(),
        event: "lateral_gmail_download_failed",
        messageId: row.messageId,
        attachmentName: originalFilename,
        error: message,
      });
      // Do NOT advance checkpoint — retry next run.
      break;
    }
  }

  if (uploadedCount > 0) {
    clearExcelCache();
    clearSkillClusterCache();
  }

  const sourceMissing = items.some((item) => item.status === "source_sheet_missing");
  const masterFailed = items.some(
    (item) => item.status === "master_discovery_failed"
  );
  const structureFailed = items.some(
    (item) => item.status === "new_sheet_structure_failed"
  );
  const deferredHint =
    syncPurpose === "staging_only"
      ? "Gmail checkpoint deferred until lateral_staging import succeeds."
      : "Gmail checkpoint deferred until Master Workbook Drive update succeeds.";
  const message =
    uploadedCount === 0 && failedCount === 0
      ? `No new Lateral Excel emails after checkpoint${
          checkpointBefore.messageId
            ? ` (${checkpointBefore.messageId})`
            : ""
        }.`
      : sourceMissing
        ? ATCI_DS_WORKSHEET_NOT_FOUND
        : structureFailed
          ? items.find((item) => item.status === "new_sheet_structure_failed")
              ?.error || "New Sheet header structure validation failed."
          : masterFailed
            ? items.find((item) => item.status === "master_discovery_failed")
                ?.error || "Master Workbook discovery failed."
            : stoppedOnFailure
              ? `Uploaded ${uploadedCount} Lateral file(s); stopped on failure — Gmail checkpoint NOT advanced. Failed: ${failedCount}.`
              : syncPurpose === "staging_only" && lastSourceRead
                ? `Uploaded ${uploadedCount} Lateral Excel file(s); read "${lastSourceRead.worksheetName}" (${lastSourceRead.rowCount}×${lastSourceRead.colCount}). ${deferredHint}`
                : lastSourceRead && lastMasterDiscovery
                  ? `Uploaded ${uploadedCount} Lateral Excel file(s); read "${lastSourceRead.worksheetName}" (${lastSourceRead.rowCount}×${lastSourceRead.colCount}); Master "${lastMasterDiscovery.fileName}" validated (${lastMasterDiscovery.masterSheet}, ${lastMasterDiscovery.newSheet}); New Sheet headers OK. ${deferredHint}`
                  : `Uploaded ${uploadedCount} Lateral Excel file(s) from Gmail (incremental). ${deferredHint}`;

  await appendLog({
    at: new Date().toISOString(),
    event: "lateral_excel_discovery_complete",
    syncPurpose,
    gmailKeywords,
    uploadedCount,
    failedCount,
    stoppedOnFailure,
    discoveredCount: queue.length,
    checkpointMessageId: checkpointAfter.messageId,
    pendingCheckpointAdvances: pendingCheckpointAdvances.length,
    lastSourceRead: lastSourceRead ?? null,
    lastMasterDiscovery: lastMasterDiscovery ?? null,
  });

  return {
    checkpointBefore,
    checkpointAfter,
    query,
    gmailKeywords,
    syncPurpose,
    scannedMessages: messageRefs.length,
    matchedAttachments: queue.length,
    processedCount,
    uploadedCount,
    failedCount,
    stoppedOnFailure,
    items,
    warnings,
    message,
    pendingCheckpointAdvances,
    lastSourceRead,
    lastMasterDiscovery,
  };
}
