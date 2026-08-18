/**
 * Update the configured Master Workbook on Google Drive in place.
 *
 * Workbook: Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm
 *
 * - Always files.update on the configured fileId (preserve identity/location)
 * - Never files.create a second Master Workbook
 * - Preserve XLSM + VBA project (macro-enabled mime)
 * - Filename stays exactly the configured Master name
 * - Post-verify File ID, filename, XLSM, VBA, New Sheet, Master Sheet, Column K
 */
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import {
  XLSM_MIME,
  assertFinalSaveIsXlsm,
  validateFinalMasterWorkbookSave,
  type FinalMasterSaveValidationResult,
} from "@/services/lateral-processing/lateral-final-master-save";
import { inspectLocalMasterWorkbookForFinalSave } from "@/services/lateral-processing/lateral-final-master-save-inspect";
import { formatProcessingDateDDMMYYYY } from "@/services/lateral-processing/lateral-new-sheet-refresh";
import {
  isForbiddenMasterIdentityFilename,
  resolveExpectedMasterFileName,
  validateMasterInPlaceIdentity,
} from "@/services/lateral-processing/lateral-master-inplace-policy";
import { isXlsmMasterFilename } from "@/services/lateral-processing/lateral-master-workbook-discovery";
import {
  DEFAULT_LATERAL_MASTER_SHEET,
  DEFAULT_LATERAL_NEW_SHEET,
} from "@/types/lateral-processing-setup";

export interface MasterDriveUpdateSuccess {
  ok: true;
  fileId: string;
  fileName: string;
  mimeType: string;
  parents: string[];
  validation: FinalMasterSaveValidationResult;
  updatedAt: string;
  createdNewFile: false;
}

export interface MasterDriveUpdateFailure {
  ok: false;
  error: string;
  phase: "precheck" | "upload" | "verify" | "content";
  validation?: FinalMasterSaveValidationResult;
}

export type MasterDriveUpdateResult =
  | MasterDriveUpdateSuccess
  | MasterDriveUpdateFailure;

/**
 * Replace content of the existing Master Workbook file. Never creates a new file.
 */
export async function updateConfiguredMasterWorkbookInPlace(options: {
  localWorkbookPath: string;
  masterFileId: string;
  masterFileName: string;
  masterSheetName?: string;
  newSheetName?: string;
  todayDDMMYYYY?: string;
  expectedClosedIds?: string[];
  expectedNewIds?: string[];
}): Promise<MasterDriveUpdateResult> {
  const expectedFileName = resolveExpectedMasterFileName(options.masterFileName);
  const fileId = options.masterFileId.trim();
  const masterSheet =
    options.masterSheetName?.trim() || DEFAULT_LATERAL_MASTER_SHEET;
  const newSheet = options.newSheetName?.trim() || DEFAULT_LATERAL_NEW_SHEET;
  const today = options.todayDDMMYYYY || formatProcessingDateDDMMYYYY();

  if (!fileId) {
    return {
      ok: false,
      phase: "precheck",
      error: "Configured Master Workbook fileId is missing.",
    };
  }

  if (isForbiddenMasterIdentityFilename(expectedFileName)) {
    return {
      ok: false,
      phase: "precheck",
      error: `Refusing Master identity filename "${expectedFileName}". Use the configured Master Workbook name — never a copy, "(1)", "_updated", or backup.`,
    };
  }

  const xlsmGate = assertFinalSaveIsXlsm(expectedFileName);
  if (!xlsmGate.ok) {
    return {
      ok: false,
      phase: "precheck",
      error: xlsmGate.error || "Master Workbook must be XLSM.",
    };
  }

  if (!existsSync(options.localWorkbookPath)) {
    return {
      ok: false,
      phase: "precheck",
      error: `Local Master workbook not found: ${options.localWorkbookPath}`,
    };
  }

  // Pre-upload content validation — never overwrite with incomplete/corrupted data
  const inspected = await inspectLocalMasterWorkbookForFinalSave({
    localPath: options.localWorkbookPath,
    fileName: expectedFileName,
    masterSheetName: masterSheet,
    newSheetName: newSheet,
    todayDDMMYYYY: today,
    expectedClosedIds: options.expectedClosedIds,
    expectedNewIds: options.expectedNewIds,
  });
  if (!inspected.ok) {
    return { ok: false, phase: "content", error: inspected.error };
  }
  const validation = validateFinalMasterWorkbookSave(inspected.snapshot);
  if (!validation.ok) {
    return {
      ok: false,
      phase: "content",
      error:
        "Master content validation failed before Drive update. Existing Master left intact. " +
        validation.reasons.join(" "),
      validation,
    };
  }

  const { drive } = await getAuthorizedGmailClient();

  // Confirm identity exists — never create
  let parents: string[] = [];
  try {
    const existing = await drive.files.get({
      fileId,
      fields: "id,name,mimeType,parents,trashed",
      supportsAllDrives: true,
    });
    if (existing.data.trashed) {
      return {
        ok: false,
        phase: "precheck",
        error: `Configured Master Workbook "${expectedFileName}" (${fileId}) is in trash. Restore it — do not create a new Master.`,
        validation,
      };
    }
    const existingName = existing.data.name || "";
    parents = existing.data.parents ?? [];
    if (!isXlsmMasterFilename(existingName)) {
      return {
        ok: false,
        phase: "precheck",
        error: `Configured Drive file is not XLSM ("${existingName}"). Refusing update that would break VBA.`,
        validation,
      };
    }
    if (isForbiddenMasterIdentityFilename(existingName)) {
      return {
        ok: false,
        phase: "precheck",
        error: `Configured Drive file looks like a duplicate/backup ("${existingName}"). Refusing to treat it as Master. Expected "${expectedFileName}".`,
        validation,
      };
    }
  } catch (err) {
    return {
      ok: false,
      phase: "precheck",
      error: `Configured Master Workbook was not found (id=${fileId}). Do not create a duplicate. ${
        err instanceof Error ? err.message : String(err)
      }`,
      validation,
    };
  }

  // Update in place — SAME fileId; keep exact Master filename; never files.create
  try {
    await drive.files.update({
      fileId,
      requestBody: {
        name: expectedFileName,
        mimeType: XLSM_MIME,
      },
      media: {
        mimeType: XLSM_MIME,
        body: createReadStream(options.localWorkbookPath),
      },
      fields: "id,name,mimeType,modifiedTime,parents",
      supportsAllDrives: true,
    });
  } catch (err) {
    return {
      ok: false,
      phase: "upload",
      error:
        err instanceof Error
          ? `Failed to update Master Workbook in place: ${err.message}`
          : "Failed to update Master Workbook in place.",
      validation,
    };
  }

  // Post-update Drive metadata verify — same File ID + exact filename
  try {
    const after = await drive.files.get({
      fileId,
      fields: "id,name,mimeType,parents",
      supportsAllDrives: true,
    });
    const identity = validateMasterInPlaceIdentity({
      expectedFileId: fileId,
      actualFileId: after.data.id,
      expectedFileName,
      actualFileName: after.data.name,
    });
    if (!identity.ok) {
      return {
        ok: false,
        phase: "verify",
        error: identity.error,
        validation,
      };
    }

    const name = after.data.name || expectedFileName;
    const mimeType = after.data.mimeType || "";
    if (!assertFinalSaveIsXlsm(name).ok) {
      return {
        ok: false,
        phase: "verify",
        error: `After update, Drive file is not XLSM (name="${name}").`,
        validation,
      };
    }
    if (
      mimeType &&
      mimeType !== XLSM_MIME &&
      !/macroenabled|ms-excel\.sheet\.macro/i.test(mimeType)
    ) {
      return {
        ok: false,
        phase: "verify",
        error: `After update, mimeType is "${mimeType}" (expected XLSM).`,
        validation,
      };
    }

    // Re-download and verify New/Master/Column K still intact on Drive copy
    const tmp = path.join(
      os.tmpdir(),
      `lateral-master-verify-${Date.now()}.xlsm`
    );
    try {
      const media = await drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" }
      );
      await fs.writeFile(tmp, Buffer.from(media.data as ArrayBuffer));
      const post = await inspectLocalMasterWorkbookForFinalSave({
        localPath: tmp,
        fileName: name,
        masterSheetName: masterSheet,
        newSheetName: newSheet,
        todayDDMMYYYY: today,
        expectedClosedIds: options.expectedClosedIds,
        expectedNewIds: options.expectedNewIds,
      });
      if (!post.ok) {
        return {
          ok: false,
          phase: "verify",
          error: `Post-update Drive content check failed: ${post.error}`,
          validation,
        };
      }
      const postValidation = validateFinalMasterWorkbookSave(post.snapshot);
      if (!postValidation.ok) {
        return {
          ok: false,
          phase: "verify",
          error:
            "Post-update verification failed (New Sheet / Master Sheet / Column K). " +
            postValidation.reasons.join(" "),
          validation: postValidation,
        };
      }

      return {
        ok: true,
        fileId,
        fileName: name,
        mimeType: mimeType || XLSM_MIME,
        parents: after.data.parents ?? parents,
        validation: postValidation,
        updatedAt: new Date().toISOString(),
        createdNewFile: false,
      };
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
  } catch (err) {
    return {
      ok: false,
      phase: "verify",
      error:
        err instanceof Error
          ? `Post-update verification failed: ${err.message}`
          : "Post-update verification failed.",
      validation,
    };
  }
}

/**
 * Destination-folder publish for the Master: update the CONFIGURED File ID only.
 * Never creates a second Master. Never switches to a different File ID found by name.
 */
export async function updateMasterInDestinationFolderWithoutCreating(options: {
  localWorkbookPath: string;
  fileName: string;
  /** Destination folder (caller context). Master is updated by File ID regardless of folder. */
  folderId: string;
  masterFileId: string;
}): Promise<
  | { ok: true; fileId: string; fileName: string; createdNewFile: false }
  | { ok: false; error: string }
> {
  void options.folderId;
  const { drive } = await getAuthorizedGmailClient();
  const expectedFileName = resolveExpectedMasterFileName(options.fileName);
  const masterFileId = options.masterFileId.trim();

  if (!masterFileId) {
    return { ok: false, error: "Configured Master File ID is required." };
  }
  if (!assertFinalSaveIsXlsm(expectedFileName).ok) {
    return {
      ok: false,
      error: `Destination Master must be XLSM ("${expectedFileName}").`,
    };
  }
  if (isForbiddenMasterIdentityFilename(expectedFileName)) {
    return {
      ok: false,
      error: `Refusing destination Master identity "${expectedFileName}".`,
    };
  }
  if (!existsSync(options.localWorkbookPath)) {
    return {
      ok: false,
      error: `Local Master workbook not found: ${options.localWorkbookPath}`,
    };
  }

  // ONLY the configured Master File ID — never list-by-name + update another file,
  // never files.create a duplicate Master in the destination folder.
  try {
    const meta = await drive.files.get({
      fileId: masterFileId,
      fields: "id,name,parents,trashed",
      supportsAllDrives: true,
    });
    if (meta.data.trashed) {
      return {
        ok: false,
        error: `Configured Master Workbook (${masterFileId}) is trashed. Restore it — do not create a new Master.`,
      };
    }

    await drive.files.update({
      fileId: masterFileId,
      requestBody: { name: expectedFileName, mimeType: XLSM_MIME },
      media: {
        mimeType: XLSM_MIME,
        body: createReadStream(options.localWorkbookPath),
      },
      fields: "id,name",
      supportsAllDrives: true,
    });

    const after = await drive.files.get({
      fileId: masterFileId,
      fields: "id,name",
      supportsAllDrives: true,
    });
    const identity = validateMasterInPlaceIdentity({
      expectedFileId: masterFileId,
      actualFileId: after.data.id,
      expectedFileName,
      actualFileName: after.data.name,
    });
    if (!identity.ok) {
      return { ok: false, error: identity.error };
    }

    return {
      ok: true,
      fileId: masterFileId,
      fileName: after.data.name || expectedFileName,
      createdNewFile: false,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to update configured Master in place (${masterFileId}): ${
        err instanceof Error ? err.message : String(err)
      }. Do not create a second Master Workbook.`,
    };
  }
}
