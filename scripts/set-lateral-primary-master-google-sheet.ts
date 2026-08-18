/**
 * Set the Google Sheet as primary Lateral Master Sheet
 * (Company → Accenture → Lateral → Master Sheet).
 *
 * Keeps the existing XLSM as processingMasterWorkbook for pipeline/VBA.
 *
 * Run: npx tsx scripts/set-lateral-primary-master-google-sheet.ts
 */
import {
  readLateralDataProcessingSetup,
  writeLateralDataProcessingSetup,
} from "../src/services/lateral-processing/setup-store";
import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import { resolveProcessingFolderId } from "../src/services/lateral-processing/setup-validation";
import { readLateralMasterSheetFromGoogleSpreadsheet } from "../src/services/excel/read-lateral-master-from-google";
import {
  GOOGLE_SHEETS_MIME_TYPE,
  withLateralDataProcessingDefaults,
} from "../src/types/lateral-processing-setup";

const PRIMARY_GOOGLE_SHEET_ID =
  process.env.LATERAL_PRIMARY_MASTER_SHEET_ID ||
  "14vmdFm0SVYmxAqxwwzTPtliL4kQrFa24ETfgpXVkHqE";

async function main() {
  const existing = await readLateralDataProcessingSetup();
  if (!existing) {
    throw new Error(
      "Lateral Data Processing Setup is not configured. Complete Dataset setup first."
    );
  }

  const { drive } = await getAuthorizedGmailClient();
  const meta = await drive.files.get({
    fileId: PRIMARY_GOOGLE_SHEET_ID,
    fields: "id,name,mimeType,parents,webViewLink,trashed",
    supportsAllDrives: true,
  });
  if (meta.data.trashed) {
    throw new Error("Target Google Sheet is in trash.");
  }
  if (meta.data.mimeType !== GOOGLE_SHEETS_MIME_TYPE) {
    throw new Error(
      `Expected Google Sheet mime, got ${meta.data.mimeType}`
    );
  }

  const previousMaster = {
    fileId: existing.masterWorkbook.fileId,
    fileName: existing.masterWorkbook.fileName,
  };

  // Preserve XLSM for pipeline when switching primary master to Google Sheet.
  let processingMaster = existing.processingMasterWorkbook;
  if (
    previousMaster.fileId &&
    previousMaster.fileId !== PRIMARY_GOOGLE_SHEET_ID &&
    /\.xlsm$/i.test(previousMaster.fileName || "")
  ) {
    processingMaster = previousMaster;
  }
  if (!processingMaster?.fileId) {
    // Fallback to known XLSM seed if needed
    processingMaster = {
      fileId: "1ztfWeVhDyzYOHlvA8ujzvtSapRDvvPw9",
      fileName: "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm",
    };
  }

  // Attach workbook into Lateral destination folder (add parent, keep existing).
  const destFolderId = resolveProcessingFolderId(existing.destinationFolder);
  const parents = meta.data.parents ?? [];
  if (destFolderId && !parents.includes(destFolderId)) {
    await drive.files.update({
      fileId: PRIMARY_GOOGLE_SHEET_ID,
      addParents: destFolderId,
      supportsAllDrives: true,
      fields: "id,parents",
    });
    console.log("added_to_destination_folder", destFolderId);
  } else {
    console.log(
      "destination_folder",
      destFolderId ? "already linked or n/a" : "not configured"
    );
  }

  const next = {
    ...withLateralDataProcessingDefaults(existing),
    updatedAt: new Date().toISOString(),
    masterWorkbook: {
      fileId: PRIMARY_GOOGLE_SHEET_ID,
      fileName:
        meta.data.name ||
        "ATCI Lateral DS AI MasterSheet Final 2026 (Google Sheet — P-Roles)",
    },
    processingMasterWorkbook: processingMaster,
    masterSheet: existing.masterSheet || "Master Sheet",
    masterNewSheet: existing.masterNewSheet || "New Sheet",
  };

  await writeLateralDataProcessingSetup(next);

  const probe = await readLateralMasterSheetFromGoogleSpreadsheet({
    spreadsheetId: PRIMARY_GOOGLE_SHEET_ID,
    sheetName: next.masterSheet,
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        primaryMaster: next.masterWorkbook,
        processingMaster: next.processingMasterWorkbook,
        companyMasterSheet: {
          sourceFile: probe.sourceFile,
          sourceLabel: probe.sourceLabel,
          sheetName: probe.sheetName,
          headers: probe.headers.slice(0, 8),
          rowCount: probe.rows.length,
        },
        webViewLink: meta.data.webViewLink,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
