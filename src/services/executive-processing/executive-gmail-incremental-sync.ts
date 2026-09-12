import fs from "node:fs/promises";
import path from "node:path";
import {
  DATASET_LOG_DIR,
  DATASET_TEMP_DIR,
  sanitizeDatasetName,
} from "@/services/dataset/paths";
import { readDatasetSetup } from "@/services/dataset/secure-store";
import { validateExcelBuffer } from "@/services/dataset/validate-excel";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import {
  getCalendarDateInTimezone,
  getStartOfCalendarDayMs,
} from "@/services/gmail/query";
import {
  ExecutiveDriveUploadError,
  uploadExecutiveExcelToDrive,
} from "@/services/executive-processing/executive-drive-upload";
import {
  buildExecutiveExcelDiscoveryQuery,
  discoverExecutiveExcelInMessage,
  originalExecutiveDsFilenameForDrive,
  preserveOriginalExecutiveDsFilename,
  sortExecutiveDiscoveriesChronologically,
  type ExecutiveDiscoveredEmail,
} from "@/services/executive-processing/executive-excel-discovery";
import {
  isAfterExecutiveGmailCheckpoint,
  readExecutiveGmailCheckpoint,
} from "@/services/executive-processing/executive-gmail-checkpoint-store";
import { DEFAULT_FILE_TYPES } from "@/types/dataset-setup";
import type { ExecutiveGmailCheckpoint } from "@/services/executive-processing/executive-gmail-checkpoint-store";

const MAX_MESSAGES = 100;

export interface ExecutiveIncrementalSyncItem {
  messageId: string;
  attachmentId: string;
  attachmentName: string;
  receivedAt: string;
  receivedAtMs: number;
  /** Display-only email metadata (never tokens) */
  sender?: string;
  subject?: string;
  status:
    | "uploaded_drive"
    | "download_failed"
    | "validation_failed"
    | "upload_failed"
    | "skipped";
  driveFileId?: string | null;
  error?: string;
  selectionReason?: string;
}

export interface ExecutivePendingCheckpointAdvance {
  messageId: string;
  attachmentId: string;
  receivedAt: string;
  receivedAtMs: number;
  attachmentFilename: string;
  driveFileId: string;
  /**
   * Local temp path of the downloaded workbook, handed off to Phase E3
   * (reconcile → executive_master). Phase E2 never reads or reconciles
   * this file's contents — discovery/dedup/upload only.
   */
  localWorkbookPath?: string;
  /** Display-only (no tokens) */
  sender?: string;
  subject?: string;
}

export interface ExecutiveGmailIncrementalSyncOptions {
  /**
   * Cap how many matched emails to download/upload in this run.
   * When set with processNewestFirst, newest emails are preferred.
   */
  maxUploads?: number;
  /** Prefer newest-first queue order (default chronological oldest-first). */
  processNewestFirst?: boolean;
}

export interface ExecutiveIncrementalSyncResult {
  checkpointBefore: ExecutiveGmailCheckpoint;
  /** Phase E2 never advances the checkpoint — always equals checkpointBefore. */
  checkpointAfter: ExecutiveGmailCheckpoint;
  query: string;
  /** Enabled Executive keyword values used to build the Gmail search */
  gmailKeywords: string[];
  scannedMessages: number;
  matchedAttachments: number;
  processedCount: number;
  uploadedCount: number;
  failedCount: number;
  /** True when a failure stopped the run before later emails were processed */
  stoppedOnFailure: boolean;
  items: ExecutiveIncrementalSyncItem[];
  warnings: string[];
  message: string;
  /**
   * Checkpoint is NOT advanced here (Phase E2).
   * Advance lands in Phase E3, only after reconcile → executive_master succeeds.
   */
  pendingCheckpointAdvances: ExecutivePendingCheckpointAdvance[];
}

async function appendLog(entry: Record<string, unknown>) {
  console.info("[executive-gmail-sync]", JSON.stringify(entry));
  try {
    await fs.mkdir(DATASET_LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(DATASET_LOG_DIR, `executive-gmail-${day}.jsonl`);
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Non-fatal — file log is supplementary when filesystem is available.
  }
}

/**
 * Executive-only incremental Gmail sync with demand-sheet discovery
 * (Phase E2 — Gmail ingestion).
 *
 * - Reads config from `setup.datasets.Executive` (same shape/store Lateral uses)
 * - Searches with configured Executive keywords, narrowed to the confirmed
 *   "ATCI Exec DS_*.xlsx" attachment-name pattern
 * - Dedups against the independent `executive` Gmail checkpoint row
 *   (Phase E1) — never touches Lateral's checkpoint
 * - Uploads to the Executive Drive folder (`resolveDriveFolderIdForDataset`)
 * - Does NOT advance the Gmail checkpoint — deferred to Phase E3
 * - Does NOT read/parse the Base DS sheet contents — that is Phase E3's job
 */
export async function runExecutiveGmailIncrementalSync(
  options?: ExecutiveGmailIncrementalSyncOptions
): Promise<ExecutiveIncrementalSyncResult> {
  const setup = await readDatasetSetup();
  if (!setup) {
    throw new Error("Complete Dataset setup before Executive Gmail sync.");
  }

  const executive = setup.datasets?.Executive;
  if (!executive || executive.enabled === false) {
    throw new Error("Executive dataset is disabled in Dataset setup.");
  }

  const checkpointBefore = await readExecutiveGmailCheckpoint();
  const warnings: string[] = [];
  const items: ExecutiveIncrementalSyncItem[] = [];
  const pendingCheckpointAdvances: ExecutivePendingCheckpointAdvance[] = [];

  const gmailKeywords = (executive.keywords ?? [])
    .filter((k) => k.enabled !== false && String(k.value ?? "").trim())
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    .map((k) => String(k.value).trim());

  const afterMs =
    checkpointBefore.receivedAtMs ??
    getStartOfCalendarDayMs(getCalendarDateInTimezone());

  if (!checkpointBefore.messageId || checkpointBefore.receivedAtMs == null) {
    warnings.push(
      `No Executive Gmail checkpoint yet — searching from start of today (${getCalendarDateInTimezone()}).`
    );
  }

  // Gmail after: can be fuzzy; query slightly before cursor then filter strictly.
  const queryAfterMs = Math.max(0, afterMs - 2000);
  const fileTypes =
    executive.fileTypes?.length > 0 ? executive.fileTypes : DEFAULT_FILE_TYPES;
  const query = buildExecutiveExcelDiscoveryQuery({
    afterMs: queryAfterMs,
    keywords: executive.keywords,
    fileTypes,
  });

  const { gmail, drive, auth } = await getAuthorizedGmailClient();

  if (
    setup.gmailAddress &&
    auth.email &&
    setup.gmailAddress.toLowerCase() !== auth.email.toLowerCase()
  ) {
    warnings.push(
      `Connected mailbox (${auth.email}) differs from setup Gmail (${setup.gmailAddress}).`
    );
  }

  await appendLog({
    at: new Date().toISOString(),
    event: "executive_excel_discovery_start",
    query,
    gmailKeywords,
    checkpointMessageId: checkpointBefore.messageId,
    checkpointReceivedAtMs: checkpointBefore.receivedAtMs,
    keywordCount: gmailKeywords.length,
  });

  const list = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: MAX_MESSAGES,
  });
  const messageRefs = list.data.messages ?? [];

  const discoveries: ExecutiveDiscoveredEmail[] = [];
  for (const ref of messageRefs) {
    if (!ref.id) continue;
    const full = await gmail.users.messages.get({
      userId: "me",
      id: ref.id,
      format: "full",
    });

    const discovered = discoverExecutiveExcelInMessage(full.data, {
      keywords: executive.keywords,
      fileTypes,
    });
    if (!discovered) continue;

    const selected = discovered.selection.selected;
    if (
      !isAfterExecutiveGmailCheckpoint(
        {
          messageId: selected.messageId,
          attachmentId: selected.attachmentId,
          receivedAtMs: selected.receivedAtMs,
        },
        checkpointBefore
      )
    ) {
      continue;
    }

    discoveries.push(discovered);
    await appendLog({
      at: new Date().toISOString(),
      event: "executive_excel_discovered",
      messageId: discovered.messageId,
      subject: discovered.subject,
      sender: discovered.sender,
      receivedAt: discovered.receivedAt,
      attachmentFilename: selected.attachmentName,
      attachmentId: selected.attachmentId,
      matchedKeyword: selected.matchedKeyword?.keyword ?? null,
      matchedIn: selected.matchedKeyword?.matchedIn ?? null,
      selectionReason: discovered.selection.selectionReason,
      rejectedAttachments: discovered.selection.rejectedAttachments,
    });
  }

  let queue = sortExecutiveDiscoveriesChronologically(discoveries);
  if (options?.processNewestFirst) {
    queue = [...queue].reverse();
  }
  if (
    typeof options?.maxUploads === "number" &&
    options.maxUploads > 0 &&
    queue.length > options.maxUploads
  ) {
    warnings.push(
      `Limiting Gmail uploads to newest/first ${options.maxUploads} of ${queue.length} matched email(s).`
    );
    queue = queue.slice(0, options.maxUploads);
  }

  const checkpointAfter = checkpointBefore;
  let uploadedCount = 0;
  let failedCount = 0;
  let stoppedOnFailure = false;
  let processedCount = 0;

  await fs.mkdir(DATASET_TEMP_DIR, { recursive: true });

  for (const discovery of queue) {
    const row = discovery.selection.selected;
    processedCount += 1;

    const originalFilename = originalExecutiveDsFilenameForDrive(
      row.attachmentName
    );
    const savedName = preserveOriginalExecutiveDsFilename(originalFilename);

    await appendLog({
      at: new Date().toISOString(),
      event: "executive_excel_selected_for_processing",
      messageId: discovery.messageId,
      subject: discovery.subject,
      sender: discovery.sender,
      attachmentFilename: originalFilename,
      preservedFilename: savedName,
      attachmentId: row.attachmentId,
      receivedAtMs: row.receivedAtMs,
      selectionReason: discovery.selection.selectionReason,
      rejectedAttachments: discovery.selection.rejectedAttachments,
      queuePosition: processedCount,
      queueSize: queue.length,
    });

    const tempDir = path.join(
      DATASET_TEMP_DIR,
      sanitizeDatasetName("Executive")
    );
    await fs.mkdir(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, savedName);

    try {
      const attachment = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: row.messageId,
        id: row.attachmentId,
      });
      const data = attachment.data.data;
      if (!data) {
        throw new Error("Gmail returned an empty attachment body.");
      }
      const buffer = Buffer.from(data, "base64url");
      await fs.writeFile(tempPath, buffer);

      const integrity = await validateExcelBuffer(buffer, originalFilename);
      if (!integrity.ok) {
        failedCount += 1;
        stoppedOnFailure = true;
        items.push({
          messageId: row.messageId,
          attachmentId: row.attachmentId,
          attachmentName: originalFilename,
          receivedAt: row.receivedAt,
          receivedAtMs: row.receivedAtMs,
          status: "validation_failed",
          error: integrity.error ?? "Excel validation failed.",
          selectionReason: discovery.selection.selectionReason,
        });
        await appendLog({
          at: new Date().toISOString(),
          event: "executive_gmail_validation_failed",
          messageId: row.messageId,
          attachmentName: originalFilename,
          error: integrity.error,
        });
        // Do NOT advance checkpoint — retry this email next run.
        break;
      }

      let driveFileId: string;
      try {
        await appendLog({
          at: new Date().toISOString(),
          event: "executive_drive_upload_start",
          messageId: row.messageId,
          originalFilename,
          fileSize: buffer.length,
        });

        const upload = await uploadExecutiveExcelToDrive({
          localPath: tempPath,
          originalFilename,
          fileSize: buffer.length,
          drive,
          setup,
        });

        driveFileId = upload.meta.driveFileId;

        await appendLog({
          at: new Date().toISOString(),
          event: "executive_drive_upload_verified",
          messageId: row.messageId,
          originalFilename,
          visibleFileName: upload.verification.visibleFileName,
          driveFileId,
          folderId: upload.verification.folderId,
          folderName: upload.verification.folderName,
          folderPathHint: upload.folderPathHint,
          size: upload.verification.size,
        });
      } catch (uploadError) {
        failedCount += 1;
        stoppedOnFailure = true;
        const message =
          uploadError instanceof ExecutiveDriveUploadError
            ? uploadError.message
            : uploadError instanceof Error
              ? uploadError.message
              : "Executive Google Drive upload failed.";
        items.push({
          messageId: row.messageId,
          attachmentId: row.attachmentId,
          attachmentName: originalFilename,
          receivedAt: row.receivedAt,
          receivedAtMs: row.receivedAtMs,
          status: "upload_failed",
          error: message,
          driveFileId: null,
          selectionReason: discovery.selection.selectionReason,
        });
        await appendLog({
          at: new Date().toISOString(),
          event: "executive_drive_upload_failed",
          messageId: row.messageId,
          attachmentName: originalFilename,
          error: message,
          code:
            uploadError instanceof ExecutiveDriveUploadError
              ? uploadError.code
              : "UPLOAD_FAILED",
        });
        // STOP — Do NOT advance checkpoint.
        break;
      }

      // Defer checkpoint until Phase E3 reconcile succeeds.
      pendingCheckpointAdvances.push({
        messageId: row.messageId,
        attachmentId: row.attachmentId,
        receivedAt: row.receivedAt,
        receivedAtMs: row.receivedAtMs,
        attachmentFilename: originalFilename,
        driveFileId,
        localWorkbookPath: tempPath,
        sender: discovery.sender,
        subject: discovery.subject,
      });
      uploadedCount += 1;
      items.push({
        messageId: row.messageId,
        attachmentId: row.attachmentId,
        attachmentName: originalFilename,
        receivedAt: row.receivedAt,
        receivedAtMs: row.receivedAtMs,
        sender: discovery.sender,
        subject: discovery.subject,
        status: "uploaded_drive",
        driveFileId,
        selectionReason: discovery.selection.selectionReason,
      });
      await appendLog({
        at: new Date().toISOString(),
        event: "executive_gmail_uploaded_pending_reconcile",
        messageId: row.messageId,
        subject: discovery.subject,
        attachmentFilename: originalFilename,
        driveFileId,
        localWorkbookPath: tempPath,
        receivedAtMs: row.receivedAtMs,
        selectionReason: discovery.selection.selectionReason,
        checkpointDeferred: true,
      });
    } catch (error) {
      failedCount += 1;
      stoppedOnFailure = true;
      const message =
        error instanceof Error ? error.message : "Attachment download failed.";
      items.push({
        messageId: row.messageId,
        attachmentId: row.attachmentId,
        attachmentName: originalFilename,
        receivedAt: row.receivedAt,
        receivedAtMs: row.receivedAtMs,
        status: "download_failed",
        error: message,
        selectionReason: discovery.selection.selectionReason,
      });
      await appendLog({
        at: new Date().toISOString(),
        event: "executive_gmail_download_failed",
        messageId: row.messageId,
        attachmentName: originalFilename,
        error: message,
      });
      // Do NOT advance checkpoint — retry next run.
      break;
    }
  }

  const message =
    uploadedCount === 0 && failedCount === 0
      ? `No new Executive demand-sheet emails after checkpoint${
          checkpointBefore.messageId ? ` (${checkpointBefore.messageId})` : ""
        }.`
      : stoppedOnFailure
        ? `Uploaded ${uploadedCount} Executive demand-sheet file(s); stopped on failure — Gmail checkpoint NOT advanced. Failed: ${failedCount}.`
        : `Uploaded ${uploadedCount} Executive demand-sheet file(s) from Gmail (incremental). Gmail checkpoint deferred until Phase E3 reconcile succeeds.`;

  await appendLog({
    at: new Date().toISOString(),
    event: "executive_excel_discovery_complete",
    gmailKeywords,
    uploadedCount,
    failedCount,
    stoppedOnFailure,
    discoveredCount: queue.length,
    checkpointMessageId: checkpointAfter.messageId,
    pendingCheckpointAdvances: pendingCheckpointAdvances.length,
  });

  return {
    checkpointBefore,
    checkpointAfter,
    query,
    gmailKeywords,
    scannedMessages: messageRefs.length,
    matchedAttachments: queue.length,
    processedCount,
    uploadedCount,
    failedCount,
    stoppedOnFailure,
    items,
    warnings,
    message,
    pendingCheckpointAdvances,
  };
}
