import fs from "node:fs/promises";
import path from "node:path";
import type {
  LateralCheckpointProcessingResult,
  LateralGmailCheckpoint,
  LateralGmailCheckpointCursor,
} from "@/types/lateral-gmail-checkpoint";
import { isPostgresMode } from "@/lib/persistence/persistence-mode";
import { getGmailCheckpointStore } from "@/lib/persistence/store-factory";

const STORE_PATH = path.join(
  process.cwd(),
  ".data",
  "lateral-gmail-checkpoint.json"
);

function emptyCheckpoint(): LateralGmailCheckpoint {
  return {
    version: 1,
    messageId: null,
    attachmentId: null,
    receivedAt: null,
    receivedAtMs: null,
    attachmentFilename: null,
    driveFileId: null,
    processedAt: null,
    processingResult: null,
    updatedAt: new Date().toISOString(),
  };
}

export async function readLateralGmailCheckpoint(): Promise<LateralGmailCheckpoint> {
  if (isPostgresMode()) return getGmailCheckpointStore().read();
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<LateralGmailCheckpoint>;
    if (parsed?.version !== 1) return emptyCheckpoint();
    return {
      version: 1,
      messageId:
        typeof parsed.messageId === "string" ? parsed.messageId : null,
      attachmentId:
        typeof parsed.attachmentId === "string" ? parsed.attachmentId : null,
      receivedAt:
        typeof parsed.receivedAt === "string" ? parsed.receivedAt : null,
      receivedAtMs:
        typeof parsed.receivedAtMs === "number" &&
        Number.isFinite(parsed.receivedAtMs)
          ? parsed.receivedAtMs
          : null,
      attachmentFilename:
        typeof parsed.attachmentFilename === "string"
          ? parsed.attachmentFilename
          : null,
      driveFileId:
        typeof parsed.driveFileId === "string" ? parsed.driveFileId : null,
      processedAt:
        typeof parsed.processedAt === "string" ? parsed.processedAt : null,
      processingResult:
        parsed.processingResult === "SUCCESS" ? "SUCCESS" : null,
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
    };
  } catch {
    return emptyCheckpoint();
  }
}

/**
 * Persist a SUCCESS checkpoint. Call ONLY via advanceFinalLateralGmailCheckpoint
 * after all pipeline gates pass. Do not call on any failure.
 */
export async function advanceLateralGmailCheckpoint(input: {
  messageId: string;
  attachmentId: string;
  receivedAt: string;
  receivedAtMs: number;
  attachmentFilename: string;
  driveFileId: string;
  processedAt?: string;
  processingResult: LateralCheckpointProcessingResult;
}): Promise<LateralGmailCheckpoint> {
  if (isPostgresMode()) {
    return getGmailCheckpointStore().advance({
      ...input,
      processingResult: "SUCCESS",
    });
  }
  if (input.processingResult !== "SUCCESS") {
    throw new Error(
      "Lateral Gmail checkpoint may only be written with processingResult=SUCCESS."
    );
  }
  if (
    !input.messageId.trim() ||
    !input.attachmentId.trim() ||
    !input.receivedAt.trim() ||
    !Number.isFinite(input.receivedAtMs) ||
    !input.attachmentFilename.trim() ||
    !input.driveFileId.trim()
  ) {
    throw new Error(
      "Lateral Gmail checkpoint requires Message ID, email timestamp, original attachment filename, and Drive file ID."
    );
  }

  const processedAt = input.processedAt ?? new Date().toISOString();
  const next: LateralGmailCheckpoint = {
    version: 1,
    messageId: input.messageId.trim(),
    attachmentId: input.attachmentId.trim(),
    receivedAt: input.receivedAt.trim(),
    receivedAtMs: input.receivedAtMs,
    attachmentFilename: input.attachmentFilename.trim(),
    driveFileId: input.driveFileId.trim(),
    processedAt,
    processingResult: "SUCCESS",
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/**
 * Strict cursor compare: (receivedAtMs, messageId, attachmentId).
 * Positive means `candidate` is strictly after `cursor`.
 */
export function compareLateralGmailCursor(
  candidate: LateralGmailCheckpointCursor,
  cursor: LateralGmailCheckpointCursor
): number {
  if (candidate.receivedAtMs !== cursor.receivedAtMs) {
    return candidate.receivedAtMs - cursor.receivedAtMs;
  }
  const byMessage = candidate.messageId.localeCompare(cursor.messageId);
  if (byMessage !== 0) return byMessage;
  return candidate.attachmentId.localeCompare(cursor.attachmentId);
}

export function isAfterLateralGmailCheckpoint(
  candidate: LateralGmailCheckpointCursor,
  checkpoint: LateralGmailCheckpoint
): boolean {
  if (!checkpoint.messageId || checkpoint.receivedAtMs == null) {
    return true;
  }
  return (
    compareLateralGmailCursor(candidate, {
      messageId: checkpoint.messageId,
      attachmentId: checkpoint.attachmentId || "",
      receivedAtMs: checkpoint.receivedAtMs,
    }) > 0
  );
}
