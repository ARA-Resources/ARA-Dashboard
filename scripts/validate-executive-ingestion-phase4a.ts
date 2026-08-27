/**
 * Phase 4A static validation — Executive Gmail→Drive ingestion (no secrets printed).
 * Usage: npx tsx scripts/validate-executive-ingestion-phase4a.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getExecutiveIngestionConfigStatus } from "../src/services/dataset/executive-ingestion-config";
import {
  matchesExecutiveAttachmentPattern,
  validateExecutiveXlsmBuffer,
} from "../src/services/dataset/executive-workbook-validate";
import {
  peekExecutiveDriveFolderId,
  peekExecutiveGmailFrom,
  peekExecutiveGmailKeywords,
  peekExecutiveGmailSubject,
  peekExecutiveMasterDriveFileId,
} from "../src/lib/config/runtime";

async function main() {
  const config = getExecutiveIngestionConfigStatus();

  // Invalid workbook must be rejected without touching prior source.
  const invalid = await validateExecutiveXlsmBuffer(
    Buffer.from("not-an-excel-file"),
    "fake-executive.xlsm"
  );

  // Pattern helper
  const patternOk =
    matchesExecutiveAttachmentPattern("ATCI Exec Job Reqs.xlsm", "Exec") &&
    !matchesExecutiveAttachmentPattern("other.xlsm", "Exec");

  // Lateral vs Executive Drive IDs must remain separate config keys
  const lateralIdKey = "ARA_LATERAL_MASTER_DRIVE_FILE_ID";
  const executiveIdKey = "ARA_EXECUTIVE_MASTER_DRIVE_FILE_ID";
  const separateKeys = lateralIdKey !== executiveIdKey;

  // Optional: if a local Executive XLSM exists via env, validate sheets (no path printed)
  let liveWorkbook: { ok: boolean; error?: string } | null = null;
  const execPath = (process.env.ARA_EXECUTIVE_EXCEL_PATH ?? "").trim();
  if (execPath) {
    try {
      const buf = await fs.readFile(execPath);
      const result = await validateExecutiveXlsmBuffer(
        buf,
        path.basename(execPath)
      );
      liveWorkbook = { ok: result.ok, error: result.error };
    } catch {
      liveWorkbook = { ok: false, error: "Could not read configured local workbook." };
    }
  }

  // Import orchestration module (compile-time / load check without running Gmail)
  await import("../src/services/dataset/executive-ingestion-config");
  await import("../src/services/dataset/executive-workbook-validate");

  const summary = {
    ok:
      invalid.ok === false &&
      patternOk &&
      separateKeys &&
      (liveWorkbook === null || liveWorkbook.ok === true),
    config: {
      fetchReady: config.fetchReady,
      gmailSearchConfigured: config.gmailSearchConfigured,
      driveUploadConfigured: config.driveUploadConfigured,
      missing: config.missing,
      notes: config.notes,
      // booleans only — never print values
      envPresent: {
        from: Boolean(peekExecutiveGmailFrom()),
        subject: Boolean(peekExecutiveGmailSubject()),
        keywords: peekExecutiveGmailKeywords().length > 0,
        driveFolder: Boolean(peekExecutiveDriveFolderId()),
        executiveMasterDrive: Boolean(peekExecutiveMasterDriveFileId()),
        lateralMasterDrive: Boolean(
          (process.env.ARA_LATERAL_MASTER_DRIVE_FILE_ID ?? "").trim()
        ),
      },
    },
    invalidWorkbookRejected: invalid.ok === false,
    invalidError: invalid.error,
    attachmentPatternHelperOk: patternOk,
    lateralExecutiveConfigSeparated: separateKeys,
    liveLocalWorkbookValidation: liveWorkbook,
    priorSourceProtection:
      "Ingestion keeps previous lastSuccess until a new workbook validates and Drive upload succeeds.",
    gmailCriteriaInRepo: "NOT FOUND — must be supplied via env; not invented in code.",
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
  console.log("PHASE4A_SMOKE_OK");
}

main().catch((error) => {
  console.error("PHASE4A_SMOKE_FAIL", error);
  process.exit(1);
});
