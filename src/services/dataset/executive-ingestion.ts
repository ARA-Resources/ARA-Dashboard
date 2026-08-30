import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import { uploadDatasetFileToDrive } from "@/services/drive/upload";
import { buildDatasetSaveFilename } from "@/services/dataset/paths";
import {
  EXECUTIVE_DATASET_NAME,
  getExecutiveIngestionConfigStatus,
  readExecutiveIngestionEnv,
} from "@/services/dataset/executive-ingestion-config";
import {
  discoverExecutiveGmailCandidates,
  downloadExecutiveGmailAttachment,
  type ExecutiveGmailCandidate,
} from "@/services/dataset/executive-gmail";
import { validateExecutiveXlsmBuffer } from "@/services/dataset/executive-workbook-validate";
import {
  ensureExecutiveStagingDirs,
  executiveCurrentDir,
  executiveTempDir,
  readExecutiveIngestionState,
  writeExecutiveIngestionState,
  type ExecutiveIngestionPhase,
} from "@/services/dataset/executive-ingestion-state";

export interface ExecutiveIngestionResult {
  ok: boolean;
  phase: ExecutiveIngestionPhase;
  message: string;
  skippedDuplicate?: boolean;
  sourceMessageId?: string;
  attachmentName?: string;
  checksumSha256?: string;
  driveFileId?: string | null;
  replacedExisting?: boolean;
  processedAt?: string;
  /** Relative path under .data only — never absolute machine path */
  localCurrentRelative?: string | null;
  candidatesConsidered?: number;
  validationError?: string;
  previousSourcePreserved?: boolean;
}

async function recordAttempt(
  phase: ExecutiveIngestionPhase,
  ok: boolean,
  message: string,
  extra?: { messageId?: string; attachmentName?: string }
) {
  const state = await readExecutiveIngestionState();
  state.lastAttempt = {
    at: new Date().toISOString(),
    phase,
    ok,
    message,
    messageId: extra?.messageId,
    attachmentName: extra?.attachmentName,
  };
  await writeExecutiveIngestionState(state);
}

/**
 * Phase 4A orchestration:
 * Gmail → download → validate → stage → Drive upload.
 * Does not reconcile Master Sheet / New / Posted / status.
 * Does not modify Gmail messages.
 * Does not overwrite previous valid source until validation + store succeed.
 */
export async function runExecutiveWorkbookIngestion(): Promise<ExecutiveIngestionResult> {
  const config = getExecutiveIngestionConfigStatus();
  if (!config.fetchReady) {
    const message = `Executive ingestion is not configured. Missing: ${config.missing.join("; ")}`;
    await recordAttempt("config_incomplete", false, message);
    return {
      ok: false,
      phase: "config_incomplete",
      message,
      previousSourcePreserved: true,
    };
  }

  const processedAt = new Date().toISOString();
  let phase: ExecutiveIngestionPhase = "fetching";

  try {
    await recordAttempt("fetching", true, "Searching Gmail for Executive workbook…");
    const { candidates } = await discoverExecutiveGmailCandidates();
    if (candidates.length === 0) {
      const message =
        "No matching Executive .xlsm attachments found for the configured Gmail criteria.";
      await recordAttempt("error", false, message);
      return {
        ok: false,
        phase: "error",
        message,
        candidatesConsidered: 0,
        previousSourcePreserved: true,
      };
    }

    // Newest first (discovery already sorts). Walk until a valid workbook is found.
    const prior = await readExecutiveIngestionState();
    let lastValidationError = "";

    for (const candidate of candidates) {
      const dup =
        prior.lastSuccess &&
        prior.lastSuccess.messageId === candidate.messageId &&
        prior.lastSuccess.attachmentId === candidate.attachmentId &&
        prior.lastSuccess.checksumSha256;

      phase = "downloading";
      await recordAttempt("downloading", true, "Downloading attachment…", {
        messageId: candidate.messageId,
        attachmentName: candidate.attachmentName,
      });

      const buffer = await downloadExecutiveGmailAttachment({
        messageId: candidate.messageId,
        attachmentId: candidate.attachmentId,
      });

      phase = "validating";
      await recordAttempt("validating", true, "Validating Executive workbook…", {
        messageId: candidate.messageId,
        attachmentName: candidate.attachmentName,
      });

      const validation = await validateExecutiveXlsmBuffer(
        buffer,
        candidate.attachmentName,
        { mimeType: candidate.mimeType }
      );

      if (!validation.ok || !validation.checksumSha256) {
        lastValidationError =
          validation.error ?? "Executive workbook validation failed.";
        // Keep searching older candidates (ambiguity policy: prefer newest valid).
        continue;
      }

      if (
        dup &&
        prior.lastSuccess?.checksumSha256 === validation.checksumSha256
      ) {
        const message =
          "This Executive workbook was already ingested successfully (same Gmail message, attachment, and checksum). Skipped duplicate Drive upload.";
        await recordAttempt("skipped_duplicate", true, message, {
          messageId: candidate.messageId,
          attachmentName: candidate.attachmentName,
        });
        return {
          ok: true,
          phase: "skipped_duplicate",
          message,
          skippedDuplicate: true,
          sourceMessageId: candidate.messageId,
          attachmentName: candidate.attachmentName,
          checksumSha256: validation.checksumSha256,
          driveFileId: prior.lastSuccess?.driveFileId ?? null,
          processedAt: prior.lastSuccess?.processedAt,
          localCurrentRelative: prior.lastSuccess?.localCurrentRelative ?? null,
          candidatesConsidered: candidates.length,
          previousSourcePreserved: true,
        };
      }

      // Stage under temp first — never delete current until after successful promote.
      await ensureExecutiveStagingDirs();
      const safeName = buildDatasetSaveFilename(candidate.attachmentName);
      const tempPath = path.join(executiveTempDir(), safeName);
      const currentPath = path.join(executiveCurrentDir(), safeName);
      await fs.writeFile(tempPath, buffer);

      phase = "uploading";
      await recordAttempt("uploading", true, "Uploading to Google Drive…", {
        messageId: candidate.messageId,
        attachmentName: candidate.attachmentName,
      });

      const env = readExecutiveIngestionEnv();
      const { drive } = await getAuthorizedGmailClient();
      const upload = await uploadDatasetFileToDrive({
        datasetName: EXECUTIVE_DATASET_NAME,
        localPath: tempPath,
        fileName: safeName,
        fileSize: buffer.length,
        folderId: env.driveFolderId,
        replacePolicy: "replace",
        drive,
      });

      // Promote staged file to current only after Drive upload succeeds.
      await fs.copyFile(tempPath, currentPath);
      try {
        await fs.unlink(tempPath);
      } catch {
        // temp cleanup is best-effort
      }

      const localCurrentRelative = path
        .join(".data", "datasets", "current", "Executive", safeName)
        .replace(/\\/g, "/");

      const state = await readExecutiveIngestionState();
      state.lastSuccess = {
        processedAt,
        messageId: candidate.messageId,
        attachmentId: candidate.attachmentId,
        attachmentName: candidate.attachmentName,
        checksumSha256: validation.checksumSha256,
        receivedAt: candidate.receivedAt,
        driveFileId: upload.meta.driveFileId,
        driveWebViewLink: upload.meta.webViewLink ?? null,
        localCurrentRelative,
        sizeBytes: buffer.length,
      };
      state.lastAttempt = {
        at: processedAt,
        phase: "success",
        ok: true,
        message: "Workbook fetched and stored.",
        messageId: candidate.messageId,
        attachmentName: candidate.attachmentName,
      };
      await writeExecutiveIngestionState(state);

      return {
        ok: true,
        phase: "success",
        message: "Workbook fetched and stored.",
        sourceMessageId: candidate.messageId,
        attachmentName: candidate.attachmentName,
        checksumSha256: validation.checksumSha256,
        driveFileId: upload.meta.driveFileId,
        replacedExisting: upload.replacedExisting,
        processedAt,
        localCurrentRelative,
        candidatesConsidered: candidates.length,
        previousSourcePreserved: true,
      };
    }

    const message =
      lastValidationError ||
      "No valid Executive workbook found among matching Gmail attachments.";
    await recordAttempt("error", false, message);
    return {
      ok: false,
      phase: "error",
      message,
      validationError: lastValidationError || undefined,
      candidatesConsidered: candidates.length,
      previousSourcePreserved: true,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Executive workbook ingestion failed.";
    // Never include tokens / secrets in messages from our code paths.
    const safe = message
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/refresh_token[=:]\s*\S+/gi, "refresh_token=[redacted]");
    await recordAttempt(phase === "fetching" ? "error" : phase, false, safe);
    return {
      ok: false,
      phase: "error",
      message: safe,
      previousSourcePreserved: true,
    };
  }
}

export type { ExecutiveGmailCandidate };
