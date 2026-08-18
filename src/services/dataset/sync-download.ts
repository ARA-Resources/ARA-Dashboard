import fs from "node:fs/promises";
import path from "node:path";
import { resolveDriveFolderIdForDataset } from "@/services/drive/folder";
import { uploadDatasetFileToDrive } from "@/services/drive/upload";
import {
  DATASET_LOG_DIR,
  DATASET_TEMP_DIR,
  buildDatasetSaveFilename,
  datasetCurrentDir,
  datasetVersionsDir,
  sanitizeDatasetName,
} from "@/services/dataset/paths";
import { resolveCurrentDatasetFile } from "@/services/dataset/resolve-current";
import { readDatasetSetup } from "@/services/dataset/secure-store";
import { validateExcelBuffer } from "@/services/dataset/validate-excel";
import { clearExcelCache } from "@/services/excel/reader";
import { clearSkillClusterCache } from "@/services/excel/extract-skill-clusters";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import {
  forgetGmailAttachments,
  forgetGmailMessageIds,
  scanGmailExcelAttachments,
} from "@/services/gmail/scan";
import type {
  DatasetSyncItemResult,
  DatasetSyncLogEntry,
  DatasetSyncResult,
} from "@/types/dataset-sync";
import { resolveExecutableDatasetNamesForRun } from "@/types/dataset-execution";


async function ensureDirs() {
  await fs.mkdir(DATASET_TEMP_DIR, { recursive: true });
  await fs.mkdir(DATASET_LOG_DIR, { recursive: true });
}

async function appendSyncLog(entries: DatasetSyncLogEntry[]) {
  if (entries.length === 0) return;
  for (const entry of entries) {
    console.info("[dataset-sync]", JSON.stringify(entry));
  }
  try {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(DATASET_LOG_DIR, `dataset-sync-${day}.jsonl`);
    const lines = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await fs.appendFile(file, lines, "utf8");
  } catch {
    // Non-fatal — file log is supplementary when filesystem is available.
  }
}

async function readCurrentFilename(datasetName: string): Promise<string | null> {
  const current = await resolveCurrentDatasetFile(datasetName);
  return current?.filePath ?? null;
}

/**
 * Scheduled sync pipeline (canonical architecture):
 * Gmail → Download → Validate Excel → Upload Google Drive →
 * Dataset Manager current → Dashboard cache clear → Company Dashboard reads Dataset Manager.
 * Failed validation/upload never overwrites the current dataset.
 */
export async function runScheduledDatasetSync(options?: {
  datasetNames?: string[];
  /** Calendar-day browse sync (optional). Default is incremental from last successful sync. */
  date?: string;
  dateMode?: string;
  scanMode?: "incremental" | "date";
  /** When set, only these scan row IDs are downloaded (manual override / single file). */
  selectedRowIds?: string[];
}): Promise<DatasetSyncResult> {
  await ensureDirs();

  const setup = await readDatasetSetup();
  if (!setup) {
    throw new Error("Complete Dataset setup before running sync.");
  }

  // Hard gate: never download/upload for Executive or Consulting.
  const { executable } = resolveExecutableDatasetNamesForRun(
    options?.datasetNames
  );

  const logs: DatasetSyncLogEntry[] = [];
  const log = (
    level: DatasetSyncLogEntry["level"],
    message: string,
    details?: Record<string, unknown>
  ) => {
    logs.push({
      at: new Date().toISOString(),
      level,
      message,
      details,
    });
  };

  const datasetFilter = new Set<string>(executable);
  const selectedIds = options?.selectedRowIds?.length
    ? new Set(options.selectedRowIds)
    : null;

  const scanMode =
    options?.scanMode ??
    (options?.date || options?.dateMode ? "date" : "incremental");

  log(
    "info",
    `Dataset sync started for ${executable.join(", ")} (${scanMode}). Executive/Consulting execution is disabled.`
  );

  const scan = await scanGmailExcelAttachments({
    datasetNames: [...executable],
    date: options?.date,
    dateMode: options?.dateMode,
    scanMode,
  });
  const { gmail, drive } = await getAuthorizedGmailClient();

  const candidates = scan.rows.filter((row) => {
    if (datasetFilter && !datasetFilter.has(row.datasetName)) return false;
    if (selectedIds) return selectedIds.has(row.id);
    return row.status === "Newest" || row.status === "Selected";
  });
  log("info", `Found ${candidates.length} Excel attachment(s) to download.`, {
    scannedMessages: scan.messageCount,
    totalMatches: scan.rows.length,
    scanMode: scan.scanMode,
    scanDate: scan.scanDate,
    afterMs: scan.afterMs,
    lastSuccessfulSyncAt: scan.lastSuccessfulSyncAt,
    datasetFilter: datasetFilter ? Array.from(datasetFilter) : null,
    selectedIds: selectedIds ? Array.from(selectedIds) : null,
  });

  const items: DatasetSyncItemResult[] = [];
  const now = new Date();


  for (const row of scan.rows) {
    const datasetName = row.datasetName;
    const sender = row.sender;
    const matchedKeyword = row.matchedKeyword;
    const matchedIn = row.matchedIn;
    const matchMode = row.matchMode;

    if (datasetFilter && !datasetFilter.has(datasetName)) {
      continue;
    }

    const isDownloadTarget = selectedIds
      ? selectedIds.has(row.id)
      : row.status === "Newest" || row.status === "Selected";

    if (row.status === "Duplicate attachment") {
      items.push({
        datasetName,
        messageId: row.messageId,
        attachmentId: row.attachmentId,
        originalName: row.attachmentName,
        renamedFile: null,
        tempPath: null,
        currentPath: await readCurrentFilename(datasetName),
        status: "skipped_duplicate",
        receivedAt: row.receivedAt,
        sender,
        matchedKeyword,
        matchedIn,
        matchMode,
      });
      continue;
    }

    if (!isDownloadTarget) {
      items.push({
        datasetName,
        messageId: row.messageId,
        attachmentId: row.attachmentId,
        originalName: row.attachmentName,
        renamedFile: null,
        tempPath: null,
        currentPath: null,
        status: "skipped_superseded",
        receivedAt: row.receivedAt,
        sender,
        matchedKeyword,
        matchedIn,
        matchMode,
      });
      continue;
    }

    const existingCurrent = await readCurrentFilename(datasetName);
    // Preserve Gmail original name + raw Office bytes (Excel 365 / .xlsx/.xlsm).
    const savedName = buildDatasetSaveFilename(row.attachmentName);
    const tempDir = path.join(
      DATASET_TEMP_DIR,
      sanitizeDatasetName(datasetName)
    );
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
      // Write bytes as-is — never re-encode with ExcelJS (keeps Excel 365 fidelity).
      await fs.writeFile(tempPath, buffer);

      log("info", "Attachment downloaded to temp storage.", {
        datasetName,
        savedName,
        originalName: row.attachmentName,
        tempPath,
        bytes: buffer.length,
      });

      const integrity = await validateExcelBuffer(buffer, row.attachmentName);
      const checksumSha256 = integrity.checksumSha256 ?? null;
      if (!integrity.ok) {
        const error =
          integrity.error ?? "Validation failed for downloaded Excel file.";
        log("error", error, {
          datasetName,
          originalName: row.attachmentName,
          tempPath,
          existingCurrent,
          checksumSha256,
        });

        // Remove invalid temp file; never overwrite current dataset.
        try {
          await fs.unlink(tempPath);
        } catch {
          // ignore
        }

        items.push({
          datasetName,
          messageId: row.messageId,
          attachmentId: row.attachmentId,
          originalName: row.attachmentName,
          renamedFile: savedName,
          tempPath: null,
          currentPath: existingCurrent,
          status: "validation_failed",
          error,
          receivedAt: row.receivedAt,
          sender,
          matchedKeyword,
          matchedIn,
          matchMode,
          checksumSha256,
          fileSize: buffer.length,
        });
        continue;
      }

      let currentPath = existingCurrent;
      let status: DatasetSyncItemResult["status"] = "stored_temp";
      let driveFileId: string | null = null;
      let driveUploadTime: string | null = null;
      let driveFileSize: number | null = null;
      let driveVersionNumber: number | null = null;

      let folderId: string;
      try {
        folderId = resolveDriveFolderIdForDataset(setup, datasetName);
      } catch (folderError) {
        const message =
          folderError instanceof Error
            ? folderError.message
            : `Drive folder not mapped for ${datasetName}.`;
        log("error", message, { datasetName });
        items.push({
          datasetName,
          messageId: row.messageId,
          attachmentId: row.attachmentId,
          originalName: row.attachmentName,
          renamedFile: savedName,
          tempPath,
          currentPath: existingCurrent,
          status: "upload_failed",
          error: message,
          receivedAt: row.receivedAt,
          sender,
          matchedKeyword,
          matchedIn,
          matchMode,
          checksumSha256,
          fileSize: buffer.length,
        });
        continue;
      }

      /**
       * Canonical pipeline:
       * Gmail → Download → Validate → Upload Drive (this dataset's folder only) →
       * Dataset Manager → Cache → Dashboard
       */
      try {
        const upload = await uploadDatasetFileToDrive({
          datasetName,
          localPath: tempPath,
          fileName: savedName,
          fileSize: buffer.length,
          folderId,
          replacePolicy: setup.fileReplacePolicy,
          drive,
        });
        driveFileId = upload.meta.driveFileId;
        driveUploadTime = upload.meta.uploadTime;
        driveFileSize = upload.meta.fileSize;
        driveVersionNumber = upload.meta.versionNumber;
        status = "uploaded_drive";
        log("info", "Uploaded dataset file to its mapped Google Drive folder.", {
          datasetName,
          folderId,
          driveFileId,
          driveFileName: savedName,
          driveVersionNumber,
          replacedExisting: upload.replacedExisting,
        });
      } catch (uploadError) {
        const message =
          uploadError instanceof Error
            ? uploadError.message
            : "Google Drive upload failed.";
        log("error", message, {
          datasetName,
          savedName,
          folderId,
        });
        // Do not update Dataset Manager when Drive upload fails.
        items.push({
          datasetName,
          messageId: row.messageId,
          attachmentId: row.attachmentId,
          originalName: row.attachmentName,
          renamedFile: savedName,
          tempPath,
          currentPath: existingCurrent,
          status: "upload_failed",
          error: message,
          receivedAt: row.receivedAt,
          sender,
          matchedKeyword,
          matchedIn,
          matchMode,
          driveFileId: null,
          driveUploadTime: null,
          driveFileSize: null,
          driveVersionNumber: null,
          checksumSha256,
          fileSize: buffer.length,
        });
        continue;
      }

      // Dataset Manager: promote validated + Drive-backed file to current
      if (setup.fileReplacePolicy === "keep_old") {
        log("info", "Drive upload ok; keeping existing Dataset Manager file (policy: No).", {
          datasetName,
          tempPath,
          existingCurrent,
        });
        status = "stored_temp";
      } else if (setup.fileReplacePolicy === "version_history") {
        const versionsDir = datasetVersionsDir(datasetName);
        const currentDir = datasetCurrentDir(datasetName);
        await fs.mkdir(versionsDir, { recursive: true });
        await fs.mkdir(currentDir, { recursive: true });

        if (existingCurrent) {
          const base = path.basename(existingCurrent);
          await fs.copyFile(existingCurrent, path.join(versionsDir, base));
        }

        const nextCurrent = path.join(currentDir, savedName);
        await fs.copyFile(tempPath, nextCurrent);
        const existing = await fs.readdir(currentDir);
        for (const file of existing) {
          if (file !== savedName) {
            await fs.unlink(path.join(currentDir, file)).catch(() => undefined);
          }
        }
        currentPath = nextCurrent;
        status = "promoted";
        log("info", "Dataset Manager updated with version history.", {
          datasetName,
          nextCurrent,
        });
      } else {
        const currentDir = datasetCurrentDir(datasetName);
        await fs.mkdir(currentDir, { recursive: true });
        const nextCurrent = path.join(currentDir, savedName);
        await fs.copyFile(tempPath, nextCurrent);
        const existing = await fs.readdir(currentDir);
        for (const file of existing) {
          if (file !== savedName) {
            await fs.unlink(path.join(currentDir, file)).catch(() => undefined);
          }
        }
        currentPath = nextCurrent;
        status = "promoted";
        log("info", "Dataset Manager current file replaced.", {
          datasetName,
          nextCurrent,
        });
      }

      // Final status reflects Drive success; promotion may still be keep_old
      if (status === "promoted") {
        status = "uploaded_drive";
      }

      items.push({
        datasetName,
        messageId: row.messageId,
        attachmentId: row.attachmentId,
        originalName: row.attachmentName,
        renamedFile: savedName,
        tempPath,
        currentPath,
        status,
        receivedAt: row.receivedAt,
        sender,
        matchedKeyword,
        matchedIn,
        matchMode,
        driveFileId,
        driveUploadTime,
        driveFileSize,
        driveVersionNumber,
        checksumSha256,
        fileSize: buffer.length,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Attachment download failed.";
      log("error", message, {
        datasetName,
        messageId: row.messageId,
        attachmentId: row.attachmentId,
        originalName: row.attachmentName,
        existingCurrent,
      });

      items.push({
        datasetName,
        messageId: row.messageId,
        attachmentId: row.attachmentId,
        originalName: row.attachmentName,
        renamedFile: savedName,
        tempPath: null,
        currentPath: existingCurrent,
        status: "download_failed",
        error: message,
        receivedAt: row.receivedAt,
        sender,
        matchedKeyword,
        matchedIn,
        matchMode,
        fileSize: row.size,
      });
    }
  }

  await appendSyncLog(logs);

  // Dashboard cache refresh — Company dashboards re-read Dataset Manager next
  clearExcelCache();
  clearSkillClusterCache();

  const failedItems = items.filter((item) =>
    ["validation_failed", "download_failed", "upload_failed"].includes(
      item.status
    )
  );
  await forgetGmailAttachments(
    failedItems.map((item) => ({
      messageId: item.messageId,
      attachmentName: item.originalName,
      size: item.fileSize ?? 0,
      datasetName: item.datasetName ?? undefined,
    }))
  );
  await forgetGmailMessageIds(failedItems.map((item) => item.messageId));

  const downloadedCount = items.filter((item) =>
    ["stored_temp", "promoted", "validated", "downloaded", "uploaded_drive"].includes(
      item.status
    )
  ).length;
  const validatedCount = items.filter((item) =>
    ["stored_temp", "promoted", "uploaded_drive"].includes(item.status)
  ).length;
  const uploadedCount = items.filter(
    (item) => item.status === "uploaded_drive"
  ).length;
  const failedCount = items.filter((item) =>
    ["validation_failed", "download_failed", "upload_failed"].includes(
      item.status
    )
  ).length;
  const preservedCurrentCount = items.filter(
    (item) =>
      item.status === "validation_failed" ||
      item.status === "download_failed" ||
      (item.status === "stored_temp" && setup.fileReplacePolicy === "keep_old")
  ).length;

  return {
    ranAt: now.toISOString(),
    query: scan.query,
    connectedEmail: scan.connectedEmail,
    items,
    logs,
    downloadedCount,
    validatedCount,
    uploadedCount,
    failedCount,
    preservedCurrentCount,
  };
}
