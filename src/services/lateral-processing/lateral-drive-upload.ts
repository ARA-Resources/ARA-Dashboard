/**
 * Lateral Google Drive upload stage for SOURCE Excel workbooks.
 *
 * Order (mandatory):
 * 1. Upload NEW workbook (always create → new File ID)
 * 2. Verify NEW workbook exists in destination folder
 * 3. ONLY THEN delete PREVIOUS source Excel by File ID from checkpoint/state
 * 4. Update source-file checkpoint (never Gmail checkpoint here)
 *
 * Never deletes the Master XLSM. Never renames the incoming Excel.
 * On upload/verify failure: throw — caller keeps previous file and stops.
 */
import { createReadStream } from "node:fs";
import type { drive_v3 } from "googleapis";
import {
  excelMimeType,
  getDatasetDriveFolderConfig,
  resolveDriveFolderIdForDataset,
} from "@/services/drive/folder";
import {
  getDatasetDriveMeta,
  upsertDatasetDriveMeta,
} from "@/services/drive/metadata-store";
import { readDatasetSetup } from "@/services/dataset/secure-store";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import { originalExcelFilenameForDrive } from "@/services/lateral-processing/lateral-excel-discovery";
import {
  collectPreviousSourceFileIdsForCleanup,
  shouldDeletePreviousSourceFile,
} from "@/services/lateral-processing/lateral-source-drive-cleanup";
import {
  readLateralSourceDriveState,
  writeLateralSourceDriveState,
} from "@/services/lateral-processing/lateral-source-drive-state-store";
import type { DatasetDriveFileMeta } from "@/types/drive-meta";
import type { DatasetSetupConfig } from "@/types/dataset-setup";

export interface LateralDriveUploadInput {
  /** Absolute path to the downloaded Excel bytes on disk */
  localPath: string;
  /**
   * ORIGINAL Gmail attachment filename.
   * Visible Drive name must match this exactly — no timestamps, UUIDs,
   * random suffixes, "processed", or "copy" prefixes added by us.
   */
  originalFilename: string;
  fileSize: number;
  /** Optional pre-authorized Drive client (COMMON Google connection). */
  drive?: drive_v3.Drive;
  setup?: DatasetSetupConfig;
  /**
   * Previous SOURCE Drive File ID from Lateral Gmail checkpoint / prior run.
   * Used ONLY for cleanup after the new file verifies — never for in-place update.
   */
  previousSourceDriveFileId?: string | null;
  /** Gmail message that produced this workbook (stored in source checkpoint). */
  messageId?: string | null;
  receivedAt?: string | null;
  /** Configured Master Workbook — never deleted during source cleanup. */
  configuredMasterFileId?: string | null;
  configuredMasterFileName?: string | null;
}

export interface LateralDriveUploadVerification {
  driveFileId: string;
  /** Visible Drive filename — must equal originalFilename */
  visibleFileName: string;
  folderId: string;
  folderName: string | null;
  mimeType: string | null;
  size: number;
  webViewLink: string | null;
  trashed: boolean;
  parents: string[];
}

export interface LateralDriveCleanupSummary {
  /** Previous source File IDs successfully deleted or confirmed absent. */
  deletedFileIds: string[];
  /** Previous source File IDs still present — retry next run. */
  pendingCleanupFileIds: string[];
  /** Human-readable notes (refusals, 404s, delete errors). */
  notes: string[];
  /** True when new upload verified but at least one previous delete failed. */
  partial: boolean;
}

export interface LateralDriveUploadResult {
  ok: true;
  meta: DatasetDriveFileMeta;
  verification: LateralDriveUploadVerification;
  /**
   * True when a previous source File ID existed and was targeted for cleanup
   * (even if that cleanup is still pending).
   */
  replacedExisting: boolean;
  folderPathHint: string;
  cleanup: LateralDriveCleanupSummary;
}

export class LateralDriveUploadError extends Error {
  readonly code:
    | "FOLDER_NOT_CONFIGURED"
    | "UPLOAD_FAILED"
    | "VERIFY_FAILED"
    | "FILENAME_MISMATCH"
    | "CONNECTION_FAILED";

  constructor(
    code: LateralDriveUploadError["code"],
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "LateralDriveUploadError";
    this.code = code;
  }
}

/**
 * Exact visible Drive filename from the Gmail attachment.
 * Never invents timestamps, UUIDs, "processed", or "copy" suffixes.
 */
export function assertLateralDriveVisibleFilename(
  originalFilename: string
): string {
  return originalExcelFilenameForDrive(originalFilename);
}

/**
 * Re-fetch the Drive file and confirm upload completed successfully
 * with the ORIGINAL visible filename in the Lateral destination folder.
 */
export async function verifyLateralDriveUpload(options: {
  drive: drive_v3.Drive;
  driveFileId: string;
  expectedFilename: string;
  expectedFolderId: string;
  expectedSize?: number;
}): Promise<LateralDriveUploadVerification> {
  const { drive, driveFileId, expectedFilename, expectedFolderId } = options;

  let file: drive_v3.Schema$File;
  try {
    const res = await drive.files.get({
      fileId: driveFileId,
      fields:
        "id, name, size, mimeType, trashed, parents, webViewLink, modifiedTime",
      supportsAllDrives: true,
    });
    file = res.data;
  } catch (error) {
    throw new LateralDriveUploadError(
      "VERIFY_FAILED",
      `Lateral Drive upload verification failed — could not read file ${driveFileId}.`,
      error
    );
  }

  if (!file.id) {
    throw new LateralDriveUploadError(
      "VERIFY_FAILED",
      "Lateral Drive upload verification failed — missing file id."
    );
  }
  if (file.trashed) {
    throw new LateralDriveUploadError(
      "VERIFY_FAILED",
      `Lateral Drive file "${expectedFilename}" is trashed after upload.`
    );
  }
  if (file.name !== expectedFilename) {
    throw new LateralDriveUploadError(
      "FILENAME_MISMATCH",
      `Lateral Drive visible filename mismatch: expected "${expectedFilename}", got "${file.name ?? ""}". Original filename must be preserved.`
    );
  }
  const parents = file.parents ?? [];
  if (!parents.includes(expectedFolderId)) {
    throw new LateralDriveUploadError(
      "VERIFY_FAILED",
      `Lateral Drive file "${expectedFilename}" is not in the configured Lateral destination folder.`
    );
  }
  if (file.mimeType?.startsWith("application/vnd.google-apps.")) {
    throw new LateralDriveUploadError(
      "VERIFY_FAILED",
      `Lateral Drive stored "${expectedFilename}" as ${file.mimeType}. Expected a native Excel file.`
    );
  }

  const size = Number(file.size ?? options.expectedSize ?? 0);
  if (options.expectedSize != null && options.expectedSize > 0 && size <= 0) {
    throw new LateralDriveUploadError(
      "VERIFY_FAILED",
      `Lateral Drive upload of "${expectedFilename}" reported empty size.`
    );
  }

  return {
    driveFileId: file.id,
    visibleFileName: file.name,
    folderId: expectedFolderId,
    folderName: null,
    mimeType: file.mimeType ?? null,
    size,
    webViewLink: file.webViewLink ?? null,
    trashed: Boolean(file.trashed),
    parents,
  };
}

async function lookupDriveFileName(
  drive: drive_v3.Drive,
  fileId: string
): Promise<{ exists: boolean; name: string | null; trashed: boolean }> {
  try {
    const res = await drive.files.get({
      fileId,
      fields: "id, name, trashed",
      supportsAllDrives: true,
    });
    return {
      exists: Boolean(res.data.id),
      name: res.data.name ?? null,
      trashed: Boolean(res.data.trashed),
    };
  } catch (error) {
    const status =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "number"
        ? (error as { code: number }).code
        : null;
    if (status === 404) {
      return { exists: false, name: null, trashed: false };
    }
    throw error;
  }
}

/**
 * Delete ONLY the listed previous SOURCE File IDs.
 * Never deletes the newly uploaded file or the Master Workbook.
 */
export async function deletePreviousLateralSourceFiles(options: {
  drive: drive_v3.Drive;
  newDriveFileId: string;
  previousFileIds: string[];
  configuredMasterFileId?: string | null;
  configuredMasterFileName?: string | null;
}): Promise<LateralDriveCleanupSummary> {
  const deletedFileIds: string[] = [];
  const pendingCleanupFileIds: string[] = [];
  const notes: string[] = [];
  const neu = options.newDriveFileId.trim();

  for (const rawId of options.previousFileIds) {
    const previousFileId = rawId.trim();
    if (!previousFileId) continue;
    if (previousFileId === neu) {
      notes.push(
        `Skipped cleanup of ${previousFileId} — equals newly uploaded File ID.`
      );
      continue;
    }

    let lookup: { exists: boolean; name: string | null; trashed: boolean };
    try {
      lookup = await lookupDriveFileName(options.drive, previousFileId);
    } catch (error) {
      pendingCleanupFileIds.push(previousFileId);
      notes.push(
        `Could not inspect previous source ${previousFileId} before delete: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
      continue;
    }

    if (!lookup.exists || lookup.trashed) {
      deletedFileIds.push(previousFileId);
      notes.push(
        `Previous source ${previousFileId} already absent or trashed — treated as cleaned.`
      );
      continue;
    }

    const gate = shouldDeletePreviousSourceFile({
      previousFileId,
      newFileId: neu,
      previousFileName: lookup.name,
      configuredMasterFileId: options.configuredMasterFileId,
      configuredMasterFileName: options.configuredMasterFileName,
    });
    if (!gate.delete) {
      notes.push(gate.reason);
      continue;
    }

    try {
      await options.drive.files.delete({
        fileId: previousFileId,
        supportsAllDrives: true,
      });
      deletedFileIds.push(previousFileId);
      notes.push(
        `Deleted previous source Excel ${previousFileId} ("${lookup.name ?? ""}").`
      );
    } catch (error) {
      const status =
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : null;
      if (status === 404) {
        deletedFileIds.push(previousFileId);
        notes.push(
          `Previous source ${previousFileId} returned 404 on delete — already absent.`
        );
        continue;
      }
      pendingCleanupFileIds.push(previousFileId);
      notes.push(
        `Failed to delete previous source ${previousFileId}: ${
          error instanceof Error ? error.message : "unknown error"
        }. New file kept; cleanup will retry next run.`
      );
    }
  }

  return {
    deletedFileIds,
    pendingCleanupFileIds: Array.from(new Set(pendingCleanupFileIds)),
    notes,
    partial: pendingCleanupFileIds.length > 0,
  };
}

/**
 * Lateral Google Drive upload stage.
 *
 * - Uses the COMMON Dataset Google Drive connection (shared OAuth)
 * - Always CREATES a new Drive file (new File ID) with the ORIGINAL filename
 * - Verifies upload BEFORE any previous-file deletion
 * - Deletes ONLY prior SOURCE File IDs from checkpoint/state (never Master)
 *
 * On upload/verify failure: throws LateralDriveUploadError — caller must STOP,
 * leave previous source file, Gmail checkpoint, and Master Workbook untouched.
 */
export async function uploadLateralExcelToDrive(
  input: LateralDriveUploadInput
): Promise<LateralDriveUploadResult> {
  const visibleName = assertLateralDriveVisibleFilename(input.originalFilename);

  const setup = input.setup ?? (await readDatasetSetup());
  if (!setup) {
    throw new LateralDriveUploadError(
      "FOLDER_NOT_CONFIGURED",
      "Complete Dataset setup before Lateral Drive upload."
    );
  }

  let folderId: string;
  try {
    folderId = resolveDriveFolderIdForDataset(setup, "Lateral");
  } catch (error) {
    throw new LateralDriveUploadError(
      "FOLDER_NOT_CONFIGURED",
      error instanceof Error
        ? error.message
        : "Lateral Google Drive destination folder is not configured.",
      error
    );
  }

  const folderConfig = getDatasetDriveFolderConfig(setup, "Lateral");
  const folderPathHint =
    folderConfig?.folderName?.trim() ||
    "configured Lateral destination folder";

  let drive = input.drive;
  if (!drive) {
    try {
      const client = await getAuthorizedGmailClient();
      drive = client.drive;
    } catch (error) {
      throw new LateralDriveUploadError(
        "CONNECTION_FAILED",
        error instanceof Error
          ? error.message
          : "Common Google Drive connection is not available.",
        error
      );
    }
  }

  const mimeType = excelMimeType(visibleName);
  const sourceStateBefore = await readLateralSourceDriveState();
  const previousMeta = await getDatasetDriveMeta("Lateral");

  // Capture previous SOURCE identities BEFORE upload. Never delete yet.
  const previousCandidates = collectPreviousSourceFileIdsForCleanup({
    newDriveFileId: "__pending_new__",
    previousSourceDriveFileId: input.previousSourceDriveFileId,
    sourceStateCurrentId: sourceStateBefore.currentSource?.driveFileId,
    driveMetaFileId: previousMeta?.driveFileId,
    pendingCleanupFileIds: sourceStateBefore.pendingCleanupFileIds,
  });

  let driveFileId: string;

  try {
    // ALWAYS create a new Drive file so the new version gets a distinct File ID.
    // Do NOT files.update in place — that would prevent safe File-ID-based cleanup
    // when the incoming Excel reuses the same original filename.
    const created = await drive.files.create({
      requestBody: {
        name: visibleName,
        parents: [folderId],
        mimeType,
      },
      media: {
        mimeType,
        body: createReadStream(input.localPath),
      },
      fields: "id, name, size, mimeType, parents, trashed, webViewLink",
      supportsAllDrives: true,
    });
    if (!created.data.id) {
      throw new LateralDriveUploadError(
        "UPLOAD_FAILED",
        `Google Drive did not return a File ID for "${visibleName}".`
      );
    }
    driveFileId = created.data.id;
  } catch (error) {
    if (error instanceof LateralDriveUploadError) throw error;
    throw new LateralDriveUploadError(
      "UPLOAD_FAILED",
      error instanceof Error
        ? `Lateral Drive upload failed for "${visibleName}": ${error.message}`
        : `Lateral Drive upload failed for "${visibleName}".`,
      error
    );
  }

  // BEFORE deleting anything: verify the NEW upload completed successfully.
  const verification = await verifyLateralDriveUpload({
    drive,
    driveFileId,
    expectedFilename: visibleName,
    expectedFolderId: folderId,
    expectedSize: input.fileSize,
  });

  const previousFileIds = collectPreviousSourceFileIdsForCleanup({
    newDriveFileId: verification.driveFileId,
    previousSourceDriveFileId: input.previousSourceDriveFileId,
    sourceStateCurrentId: sourceStateBefore.currentSource?.driveFileId,
    driveMetaFileId: previousMeta?.driveFileId,
    pendingCleanupFileIds: sourceStateBefore.pendingCleanupFileIds,
  });

  // ONLY AFTER successful verification — delete previous SOURCE by File ID.
  const cleanup = await deletePreviousLateralSourceFiles({
    drive,
    newDriveFileId: verification.driveFileId,
    previousFileIds,
    configuredMasterFileId: input.configuredMasterFileId,
    configuredMasterFileName: input.configuredMasterFileName,
  });

  const uploadedAt = new Date().toISOString();
  const meta: DatasetDriveFileMeta = {
    datasetName: "Lateral",
    driveFileId: verification.driveFileId,
    fileName: verification.visibleFileName,
    uploadTime: uploadedAt,
    fileSize: verification.size || input.fileSize,
    versionNumber: (previousMeta?.versionNumber ?? 0) + 1,
    webViewLink: verification.webViewLink,
    folderId,
  };

  // Source checkpoint: update only after upload + verify + cleanup attempt
  // (successful delete OR confirmed absent OR queued for retry — never on upload fail).
  await writeLateralSourceDriveState({
    version: 1,
    currentSource: {
      driveFileId: verification.driveFileId,
      fileName: verification.visibleFileName,
      messageId: input.messageId?.trim() || null,
      receivedAt: input.receivedAt ?? null,
      uploadedAt,
    },
    pendingCleanupFileIds: cleanup.pendingCleanupFileIds,
    updatedAt: uploadedAt,
  });
  await upsertDatasetDriveMeta(meta);

  try {
    const { invalidateDriveFolderStatsCache } = await import(
      "@/services/drive/folder-stats"
    );
    invalidateDriveFolderStatsCache();
  } catch {
    // non-fatal
  }

  return {
    ok: true,
    meta,
    verification: {
      ...verification,
      folderName: folderConfig?.folderName ?? null,
    },
    replacedExisting: previousCandidates.length > 0,
    folderPathHint,
    cleanup,
  };
}
