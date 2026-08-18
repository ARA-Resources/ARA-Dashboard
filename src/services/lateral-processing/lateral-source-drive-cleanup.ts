/**
 * Safe helpers for Lateral source Excel Drive replace:
 * upload NEW → verify → delete PREVIOUS source by File ID.
 * Never deletes the Master Workbook.
 */
import { FINAL_MASTER_WORKBOOK_NAME } from "@/services/lateral-processing/lateral-final-master-save";
import { isXlsmMasterFilename } from "@/services/lateral-processing/lateral-master-workbook-discovery";
import { DEFAULT_LATERAL_MASTER_WORKBOOK_NAME } from "@/types/lateral-processing-setup";

/**
 * Protect Master XLSM from source-file cleanup.
 * Matches configured Master name and the default Final Master filename.
 */
export function isProtectedLateralMasterWorkbook(options: {
  fileId: string;
  fileName?: string | null;
  configuredMasterFileId?: string | null;
  configuredMasterFileName?: string | null;
}): boolean {
  const id = options.fileId.trim();
  if (!id) return true;
  const masterId = options.configuredMasterFileId?.trim();
  if (masterId && id === masterId) return true;

  const name = (options.fileName ?? "").trim();
  if (!name) return false;

  const configuredName =
    options.configuredMasterFileName?.trim() ||
    DEFAULT_LATERAL_MASTER_WORKBOOK_NAME;
  if (name === configuredName) return true;
  if (name === FINAL_MASTER_WORKBOOK_NAME) return true;
  if (isXlsmMasterFilename(name) && /mastersheet/i.test(name)) return true;
  return false;
}

/**
 * Collect previous SOURCE file IDs to delete after a new upload verifies.
 * Never includes the new file id. Dedupes. Does not decide Master protection
 * by name alone here (caller also checks Drive metadata before delete).
 */
export function collectPreviousSourceFileIdsForCleanup(options: {
  newDriveFileId: string;
  previousSourceDriveFileId?: string | null;
  sourceStateCurrentId?: string | null;
  driveMetaFileId?: string | null;
  pendingCleanupFileIds?: string[] | null;
}): string[] {
  const neu = options.newDriveFileId.trim();
  const ids = [
    options.previousSourceDriveFileId,
    options.sourceStateCurrentId,
    options.driveMetaFileId,
    ...(options.pendingCleanupFileIds ?? []),
  ]
    .map((id) => (typeof id === "string" ? id.trim() : ""))
    .filter((id) => id.length > 0 && id !== neu);
  return Array.from(new Set(ids));
}

export function shouldDeletePreviousSourceFile(options: {
  previousFileId: string;
  newFileId: string;
  previousFileName?: string | null;
  configuredMasterFileId?: string | null;
  configuredMasterFileName?: string | null;
}): { delete: boolean; reason: string } {
  const prev = options.previousFileId.trim();
  const neu = options.newFileId.trim();
  if (!prev) {
    return { delete: false, reason: "No previous source File ID." };
  }
  if (prev === neu) {
    return {
      delete: false,
      reason: "Previous File ID equals newly uploaded File ID — skip delete.",
    };
  }
  if (
    isProtectedLateralMasterWorkbook({
      fileId: prev,
      fileName: options.previousFileName,
      configuredMasterFileId: options.configuredMasterFileId,
      configuredMasterFileName: options.configuredMasterFileName,
    })
  ) {
    return {
      delete: false,
      reason: `Refusing to delete protected Master Workbook (${options.previousFileName || prev}).`,
    };
  }
  return { delete: true, reason: "Safe to delete previous source workbook." };
}
