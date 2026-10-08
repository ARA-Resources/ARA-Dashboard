/**
 * The Posted button's own, minimal `drive.files.update` full-file-replace —
 * deliberately NOT `updateConfiguredMasterWorkbookInPlace` (Lateral) or
 * `syncExecutiveMasterWorkbookMirror` (Executive): both of those carry
 * heavy, pipeline-specific content validation (expected-closed-IDs, New
 * Sheet row counts, etc.) that doesn't apply to this feature's narrow
 * single-tab edit, and reusing them would couple this button to Run All's
 * own save semantics. This is the one place the edited local copy is ever
 * written back to the live file — a single call, so a failure here can
 * never leave the live sheet half-written.
 */
import { createReadStream } from "node:fs";
import type { drive_v3 } from "googleapis";

export const POSTED_WORKBOOK_XLSM_MIME = "application/vnd.ms-excel.sheet.macroEnabled.12";

export async function uploadPostedWorkbookInPlace(
  drive: drive_v3.Drive,
  fileId: string,
  localPath: string
): Promise<void> {
  await drive.files.update({
    fileId,
    requestBody: { mimeType: POSTED_WORKBOOK_XLSM_MIME },
    media: {
      mimeType: POSTED_WORKBOOK_XLSM_MIME,
      body: createReadStream(localPath),
    },
    fields: "id, name, mimeType, modifiedTime",
    supportsAllDrives: true,
  });
}
