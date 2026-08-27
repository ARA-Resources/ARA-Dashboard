import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import { peekExecutiveNewSheetSpreadsheetId as peekSpreadsheetIdEnv } from "@/lib/config/runtime";
import {
  EXECUTIVE_NEW_SHEET_SPREADSHEET_ID_DEFAULT,
  isExecutiveDsAttachmentName,
} from "@/services/dataset/executive-dataset-mapping";
import {
  discoverExecutiveDsGmailCandidates,
  downloadExecutiveDsAttachment,
} from "@/services/dataset/executive-ds-gmail";
import { readExecutiveBaseDsFromBuffer } from "@/services/dataset/executive-base-ds-reader";
import {
  previewExecutiveNewSheetHeaders,
  replaceExecutiveNewSheetData,
} from "@/services/dataset/executive-new-sheet-writer";
import {
  ensureExecutiveStagingDirs,
  executiveTempDir,
} from "@/services/dataset/executive-ingestion-state";
import { buildDatasetSaveFilename } from "@/services/dataset/paths";
import {
  readEncryptedJson,
  writeEncryptedJson,
} from "@/services/dataset/encrypted-json-store";

export type ExecutiveDatasetImportPhase =
  | "idle"
  | "finding"
  | "downloading"
  | "reading_base_ds"
  | "validating_columns"
  | "clearing_new_sheet"
  | "writing"
  | "verifying"
  | "complete"
  | "error"
  | "config_incomplete";

export interface ExecutiveDatasetImportResult {
  ok: boolean;
  phase: ExecutiveDatasetImportPhase;
  message: string;
  existingNewSheetUnchanged?: boolean;
  clearedBeforeWrite?: boolean;
  partialWrite?: boolean;
  attachmentName?: string;
  sourceMessageId?: string;
  sourceRowCount?: number;
  destinationRowCount?: number;
  spreadsheetId?: string;
  sheetName?: string;
  unmappedDestinationHeaders?: string[];
  processedAt?: string;
}

const STATE_FILE = "executive-dataset-import-state.enc.json";

function peekExecutiveNewSheetSpreadsheetId(): string {
  return (
    peekSpreadsheetIdEnv() || EXECUTIVE_NEW_SHEET_SPREADSHEET_ID_DEFAULT
  );
}

export function getExecutiveDatasetImportConfigStatus() {
  const spreadsheetId = peekExecutiveNewSheetSpreadsheetId();
  const missing: string[] = [];
  // Confirmed filename pattern is baked in; optional Gmail from/subject/keywords not required.
  if (!spreadsheetId) {
    missing.push("ARA_EXECUTIVE_NEW_SHEET_SPREADSHEET_ID");
  }
  return {
    fetchReady: Boolean(spreadsheetId),
    spreadsheetConfigured: Boolean(spreadsheetId),
    spreadsheetIdConfigured: Boolean(spreadsheetId),
    /** Never expose full ID to casual UI lists — API may return masked. */
    spreadsheetIdMasked: spreadsheetId
      ? `${spreadsheetId.slice(0, 6)}…${spreadsheetId.slice(-4)}`
      : null,
    attachmentPattern: "ATCI Exec DS_<date>.xlsx",
    sourceSheet: "Base DS",
    destinationSheet: "New Sheet",
    missing,
    notes: [
      "Phase 4B updates Google Sheet New Sheet only — Master Sheet is not processed.",
      "Confirmed attachment naming: ATCI Exec DS_<date>.xlsx",
    ],
  };
}

async function writeImportAttempt(payload: {
  at: string;
  phase: ExecutiveDatasetImportPhase;
  ok: boolean;
  message: string;
  attachmentName?: string;
}) {
  const prev =
    (await readEncryptedJson<{
      lastAttempt?: unknown;
      lastSuccess?: unknown;
    }>(STATE_FILE)) ?? {};
  await writeEncryptedJson(STATE_FILE, {
    ...prev,
    updatedAt: payload.at,
    lastAttempt: payload,
  });
}

/**
 * Phase 4B: Gmail Exec DS XLSX → Base DS → Google Sheet New Sheet.
 */
export async function runExecutiveDatasetImport(): Promise<ExecutiveDatasetImportResult> {
  const config = getExecutiveDatasetImportConfigStatus();
  if (!config.fetchReady) {
    const message = `Executive dataset import is not configured. Missing: ${config.missing.join("; ")}`;
    await writeImportAttempt({
      at: new Date().toISOString(),
      phase: "config_incomplete",
      ok: false,
      message,
    });
    return {
      ok: false,
      phase: "config_incomplete",
      message,
      existingNewSheetUnchanged: true,
    };
  }

  const spreadsheetId = peekExecutiveNewSheetSpreadsheetId();
  const processedAt = new Date().toISOString();
  let phase: ExecutiveDatasetImportPhase = "finding";
  let clearedBeforeWrite = false;

  try {
    await writeImportAttempt({
      at: processedAt,
      phase: "finding",
      ok: true,
      message: "Finding latest Exec DS workbook…",
    });

    const { candidates } = await discoverExecutiveDsGmailCandidates();
    const latest = candidates.find((item) =>
      isExecutiveDsAttachmentName(item.attachmentName)
    );
    if (!latest) {
      const message =
        "No matching ATCI Exec DS_<date>.xlsx attachment found in Gmail.";
      await writeImportAttempt({
        at: new Date().toISOString(),
        phase: "error",
        ok: false,
        message,
      });
      return {
        ok: false,
        phase: "error",
        message,
        existingNewSheetUnchanged: true,
      };
    }

    phase = "downloading";
    await writeImportAttempt({
      at: new Date().toISOString(),
      phase,
      ok: true,
      message: "Downloading workbook…",
      attachmentName: latest.attachmentName,
    });
    const buffer = await downloadExecutiveDsAttachment({
      messageId: latest.messageId,
      attachmentId: latest.attachmentId,
    });

    await ensureExecutiveStagingDirs();
    const tempName = buildDatasetSaveFilename(latest.attachmentName);
    const tempPath = path.join(executiveTempDir(), tempName);
    await fs.writeFile(tempPath, buffer);

    phase = "reading_base_ds";
    await writeImportAttempt({
      at: new Date().toISOString(),
      phase,
      ok: true,
      message: "Reading Base DS…",
      attachmentName: latest.attachmentName,
    });
    const baseDs = await readExecutiveBaseDsFromBuffer(buffer);

    phase = "validating_columns";
    await writeImportAttempt({
      at: new Date().toISOString(),
      phase,
      ok: true,
      message: "Validating columns…",
      attachmentName: latest.attachmentName,
    });

    const { sheets } = await getAuthorizedGmailClient();
    // Validate destination headers BEFORE clearing.
    const preview = await previewExecutiveNewSheetHeaders({
      sheets,
      spreadsheetId,
    });
    void preview;

    phase = "clearing_new_sheet";
    await writeImportAttempt({
      at: new Date().toISOString(),
      phase,
      ok: true,
      message: "Clearing New Sheet data…",
      attachmentName: latest.attachmentName,
    });

    phase = "writing";
    const writeResult = await replaceExecutiveNewSheetData({
      sheets,
      spreadsheetId,
      sourceHeaders: baseDs.headers,
      sourceRows: baseDs.rows,
    });
    clearedBeforeWrite = writeResult.clearedBeforeWrite;

    phase = "verifying";
    await writeImportAttempt({
      at: new Date().toISOString(),
      phase: "complete",
      ok: true,
      message: "Executive dataset updated successfully.",
      attachmentName: latest.attachmentName,
    });

    const prev =
      (await readEncryptedJson<Record<string, unknown>>(STATE_FILE)) ?? {};
    await writeEncryptedJson(STATE_FILE, {
      ...prev,
      updatedAt: processedAt,
      lastSuccess: {
        processedAt,
        messageId: latest.messageId,
        attachmentName: latest.attachmentName,
        sourceRowCount: baseDs.rowCount,
        destinationRowCount: writeResult.rowsWritten,
        spreadsheetIdMasked: config.spreadsheetIdMasked,
        sheetName: writeResult.sheetName,
      },
    });

    return {
      ok: true,
      phase: "complete",
      message: "Executive dataset updated successfully.",
      existingNewSheetUnchanged: false,
      clearedBeforeWrite,
      partialWrite: false,
      attachmentName: latest.attachmentName,
      sourceMessageId: latest.messageId,
      sourceRowCount: baseDs.rowCount,
      destinationRowCount: writeResult.rowsWritten,
      spreadsheetId: writeResult.spreadsheetId,
      sheetName: writeResult.sheetName,
      unmappedDestinationHeaders: writeResult.unmappedDestinationHeaders,
      processedAt,
    };
  } catch (error) {
    const raw =
      error instanceof Error
        ? error.message
        : "Executive dataset update did not complete.";
    const safe = raw
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/refresh_token[=:]\s*\S+/gi, "refresh_token=[redacted]");

    const afterClear =
      clearedBeforeWrite ||
      /did not complete after New Sheet was cleared|verification failed/i.test(
        safe
      );

    const message = afterClear
      ? `Executive dataset update did not complete. ${safe}`
      : `${safe} Existing Executive New Sheet data was not changed.`;

    await writeImportAttempt({
      at: new Date().toISOString(),
      phase: "error",
      ok: false,
      message,
    });

    return {
      ok: false,
      phase: "error",
      message,
      existingNewSheetUnchanged: !afterClear,
      clearedBeforeWrite: afterClear,
      partialWrite: afterClear,
    };
  }
}
