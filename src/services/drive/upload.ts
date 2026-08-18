import { createReadStream } from "node:fs";
import type { drive_v3 } from "googleapis";
import { excelMimeType } from "@/services/drive/folder";
import {
  getDatasetDriveMeta,
  upsertDatasetDriveMeta,
} from "@/services/drive/metadata-store";
import type { FileReplacePolicy } from "@/types/dataset-setup";
import type { DatasetDriveFileMeta } from "@/types/drive-meta";

export interface DriveUploadInput {
  datasetName: string;
  localPath: string;
  fileName: string;
  fileSize: number;
  /** Must be this dataset's mapped folder — never another dataset's */
  folderId: string;
  replacePolicy: FileReplacePolicy;
  drive: drive_v3.Drive;
}

export interface DriveUploadResult {
  meta: DatasetDriveFileMeta;
  replacedExisting: boolean;
}

/**
 * Upload a validated Excel file to the dataset's mapped Drive folder only.
 * Stores native Microsoft Excel Open XML (.xlsx / .xlsm) — never converts to
 * Google Sheets — so the file opens in Microsoft Excel 365 with its original name.
 * - replace: update previous Drive file in place when it still lives in the mapped folder
 * - version_history / keep_old: create a new file in the mapped folder
 */
export async function uploadDatasetFileToDrive(
  input: DriveUploadInput
): Promise<DriveUploadResult> {
  const previous = await getDatasetDriveMeta(input.datasetName);
  const nextVersion = (previous?.versionNumber ?? 0) + 1;
  // Office Open XML / Excel 365 MIME — keeps file openable in Microsoft Excel.
  const mimeType = excelMimeType(input.fileName);
  const media = {
    mimeType,
    body: createReadStream(input.localPath),
  };

  let file: drive_v3.Schema$File | null = null;
  let replacedExisting = false;

  if (input.replacePolicy === "replace" && previous?.driveFileId) {
    const previousInMappedFolder =
      !previous.folderId || previous.folderId === input.folderId;
    if (previousInMappedFolder) {
      try {
        const updated = await input.drive.files.update({
          fileId: previous.driveFileId,
          requestBody: {
            name: input.fileName,
            mimeType,
          },
          media,
          fields: "id, name, size, modifiedTime, webViewLink, mimeType",
          supportsAllDrives: true,
        });
        file = updated.data;
        replacedExisting = true;
      } catch {
        // Fall back to create in the mapped folder.
      }
    }
  }

  if (!file) {
    const created = await input.drive.files.create({
      requestBody: {
        name: input.fileName,
        parents: [input.folderId],
        mimeType,
      },
      media: {
        mimeType,
        body: createReadStream(input.localPath),
      },
      fields: "id, name, size, modifiedTime, webViewLink, mimeType",
      supportsAllDrives: true,
    });
    file = created.data;
    replacedExisting = false;
  }

  if (!file.id) {
    throw new Error("Google Drive upload did not return a File ID.");
  }

  // Guard: never leave a Google Sheets conversion behind for Excel datasets.
  if (file.mimeType?.startsWith("application/vnd.google-apps.")) {
    throw new Error(
      `Drive stored "${input.fileName}" as ${file.mimeType}. Expected a native Excel file for Excel 365.`
    );
  }

  const meta: DatasetDriveFileMeta = {
    datasetName: input.datasetName,
    driveFileId: file.id,
    fileName: file.name ?? input.fileName,
    uploadTime: file.modifiedTime ?? new Date().toISOString(),
    fileSize: Number(file.size ?? input.fileSize),
    versionNumber: nextVersion,
    webViewLink: file.webViewLink ?? null,
    folderId: input.folderId,
  };

  await upsertDatasetDriveMeta(meta);
  const { invalidateDriveFolderStatsCache } = await import(
    "@/services/drive/folder-stats"
  );
  invalidateDriveFolderStatsCache();
  return { meta, replacedExisting };
}
