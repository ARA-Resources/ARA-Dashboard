/**
 * Executive Google Drive upload stage for demand-sheet Excel workbooks
 * (Phase E2).
 *
 * Simplified relative to `lateral-drive-upload.ts` by design, not by
 * omission: Lateral's source file keeps a constant name across runs, so it
 * needs File-ID-based "verify new, then delete previous" cleanup to avoid
 * accumulating stale copies under one visible name. The Executive demand
 * sheet is named with its own date (`ATCI Exec DS_<date>.xlsx`), so every
 * day's upload is already uniquely named — nothing to replace, nothing to
 * clean up. Each verified upload is simply additional dated history in the
 * configured Drive folder. Never deletes anything.
 *
 * Order (mandatory):
 * 1. Upload NEW workbook (always create → new File ID)
 * 2. Verify NEW workbook exists in the configured Executive destination folder
 *
 * On upload/verify failure: throw — caller stops and does not advance the
 * Gmail checkpoint.
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
import { originalExecutiveDsFilenameForDrive } from "@/services/executive-processing/executive-excel-discovery";
import type { DatasetDriveFileMeta } from "@/types/drive-meta";
import type { DatasetSetupConfig } from "@/types/dataset-setup";

export interface ExecutiveDriveUploadInput {
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
}

export interface ExecutiveDriveUploadVerification {
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

export interface ExecutiveDriveUploadResult {
  ok: true;
  meta: DatasetDriveFileMeta;
  verification: ExecutiveDriveUploadVerification;
  folderPathHint: string;
}

export class ExecutiveDriveUploadError extends Error {
  readonly code:
    | "FOLDER_NOT_CONFIGURED"
    | "UPLOAD_FAILED"
    | "VERIFY_FAILED"
    | "FILENAME_MISMATCH"
    | "CONNECTION_FAILED";

  constructor(
    code: ExecutiveDriveUploadError["code"],
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "ExecutiveDriveUploadError";
    this.code = code;
  }
}

/**
 * Re-fetch the Drive file and confirm upload completed successfully
 * with the ORIGINAL visible filename in the Executive destination folder.
 */
export async function verifyExecutiveDriveUpload(options: {
  drive: drive_v3.Drive;
  driveFileId: string;
  expectedFilename: string;
  expectedFolderId: string;
  expectedSize?: number;
}): Promise<ExecutiveDriveUploadVerification> {
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
    throw new ExecutiveDriveUploadError(
      "VERIFY_FAILED",
      `Executive Drive upload verification failed — could not read file ${driveFileId}.`,
      error
    );
  }

  if (!file.id) {
    throw new ExecutiveDriveUploadError(
      "VERIFY_FAILED",
      "Executive Drive upload verification failed — missing file id."
    );
  }
  if (file.trashed) {
    throw new ExecutiveDriveUploadError(
      "VERIFY_FAILED",
      `Executive Drive file "${expectedFilename}" is trashed after upload.`
    );
  }
  if (file.name !== expectedFilename) {
    throw new ExecutiveDriveUploadError(
      "FILENAME_MISMATCH",
      `Executive Drive visible filename mismatch: expected "${expectedFilename}", got "${file.name ?? ""}". Original filename must be preserved.`
    );
  }
  const parents = file.parents ?? [];
  if (!parents.includes(expectedFolderId)) {
    throw new ExecutiveDriveUploadError(
      "VERIFY_FAILED",
      `Executive Drive file "${expectedFilename}" is not in the configured Executive destination folder.`
    );
  }
  if (file.mimeType?.startsWith("application/vnd.google-apps.")) {
    throw new ExecutiveDriveUploadError(
      "VERIFY_FAILED",
      `Executive Drive stored "${expectedFilename}" as ${file.mimeType}. Expected a native Excel file.`
    );
  }

  const size = Number(file.size ?? options.expectedSize ?? 0);
  if (options.expectedSize != null && options.expectedSize > 0 && size <= 0) {
    throw new ExecutiveDriveUploadError(
      "VERIFY_FAILED",
      `Executive Drive upload of "${expectedFilename}" reported empty size.`
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

/**
 * Executive Google Drive upload stage.
 *
 * - Uses the COMMON Dataset Google Drive connection (shared OAuth)
 * - Always CREATES a new Drive file (new File ID) with the ORIGINAL filename
 * - Verifies upload BEFORE returning
 * - Never deletes anything (see module doc — dated filenames never collide)
 *
 * On upload/verify failure: throws ExecutiveDriveUploadError — caller must
 * STOP and leave the Gmail checkpoint untouched.
 */
export async function uploadExecutiveExcelToDrive(
  input: ExecutiveDriveUploadInput
): Promise<ExecutiveDriveUploadResult> {
  const visibleName = originalExecutiveDsFilenameForDrive(
    input.originalFilename
  );

  const setup = input.setup ?? (await readDatasetSetup());
  if (!setup) {
    throw new ExecutiveDriveUploadError(
      "FOLDER_NOT_CONFIGURED",
      "Complete Dataset setup before Executive Drive upload."
    );
  }

  let folderId: string;
  try {
    folderId = resolveDriveFolderIdForDataset(setup, "Executive");
  } catch (error) {
    throw new ExecutiveDriveUploadError(
      "FOLDER_NOT_CONFIGURED",
      error instanceof Error
        ? error.message
        : "Executive Google Drive destination folder is not configured.",
      error
    );
  }

  const folderConfig = getDatasetDriveFolderConfig(setup, "Executive");
  const folderPathHint =
    folderConfig?.folderName?.trim() ||
    "configured Executive destination folder";

  let drive = input.drive;
  if (!drive) {
    try {
      const client = await getAuthorizedGmailClient();
      drive = client.drive;
    } catch (error) {
      throw new ExecutiveDriveUploadError(
        "CONNECTION_FAILED",
        error instanceof Error
          ? error.message
          : "Common Google Drive connection is not available.",
        error
      );
    }
  }

  const mimeType = excelMimeType(visibleName);
  const previousMeta = await getDatasetDriveMeta("Executive");

  let driveFileId: string;

  try {
    // ALWAYS create a new Drive file — every day's demand sheet has its own
    // dated name, so this never overwrites a prior day's upload.
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
      throw new ExecutiveDriveUploadError(
        "UPLOAD_FAILED",
        `Google Drive did not return a File ID for "${visibleName}".`
      );
    }
    driveFileId = created.data.id;
  } catch (error) {
    if (error instanceof ExecutiveDriveUploadError) throw error;
    throw new ExecutiveDriveUploadError(
      "UPLOAD_FAILED",
      error instanceof Error
        ? `Executive Drive upload failed for "${visibleName}": ${error.message}`
        : `Executive Drive upload failed for "${visibleName}".`,
      error
    );
  }

  const verification = await verifyExecutiveDriveUpload({
    drive,
    driveFileId,
    expectedFilename: visibleName,
    expectedFolderId: folderId,
    expectedSize: input.fileSize,
  });

  const uploadedAt = new Date().toISOString();
  const meta: DatasetDriveFileMeta = {
    datasetName: "Executive",
    driveFileId: verification.driveFileId,
    fileName: verification.visibleFileName,
    uploadTime: uploadedAt,
    fileSize: verification.size || input.fileSize,
    versionNumber: (previousMeta?.versionNumber ?? 0) + 1,
    webViewLink: verification.webViewLink,
    folderId,
  };
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
    folderPathHint,
  };
}
