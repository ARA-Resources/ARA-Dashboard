import fs from "node:fs/promises";
import path from "node:path";
import type {
  LateralCheckpointProcessingResult,
  LateralGmailCheckpoint,
  LateralGmailCheckpointCursor,
  LateralGmailRecentFingerprint,
} from "@/types/lateral-gmail-checkpoint";
import { isPostgresMode } from "@/lib/persistence/persistence-mode";
import { getGmailCheckpointStore } from "@/lib/persistence/store-factory";
import {
  appendRecentFingerprint,
  attachmentFingerprint,
} from "@/services/gmail/attachments";

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
    recentFingerprints: [],
    updatedAt: new Date().toISOString(),
  };
}

function parseRecentFingerprints(value: unknown): LateralGmailRecentFingerprint[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is LateralGmailRecentFingerprint =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>).fingerprint === "string" &&
      typeof (entry as Record<string, unknown>).messageId === "string" &&
      typeof (entry as Record<string, unknown>).receivedAtMs === "number" &&
      typeof (entry as Record<string, unknown>).processedAt === "string"
  );
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
      recentFingerprints: parseRecentFingerprints(parsed.recentFingerprints),
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
  /** Attachment size in bytes — used only to compute a content fingerprint. */
  attachmentSize: number;
  driveFileId: string;
  processedAt?: string;
  processingResult: LateralCheckpointProcessingResult;
}): Promise<LateralGmailCheckpoint> {
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
    !Number.isFinite(input.attachmentSize) ||
    !input.driveFileId.trim()
  ) {
    throw new Error(
      "Lateral Gmail checkpoint requires Message ID, email timestamp, original attachment filename, attachment size, and Drive file ID."
    );
  }

  const processedAt = input.processedAt ?? new Date().toISOString();
  const newFingerprint = {
    fingerprint: attachmentFingerprint({
      datasetName: "Lateral",
      attachmentName: input.attachmentFilename.trim(),
      size: input.attachmentSize,
    }),
    messageId: input.messageId.trim(),
    receivedAtMs: input.receivedAtMs,
    processedAt,
  };

  if (isPostgresMode()) {
    return getGmailCheckpointStore().advance({
      messageId: input.messageId,
      attachmentId: input.attachmentId,
      receivedAt: input.receivedAt,
      receivedAtMs: input.receivedAtMs,
      attachmentFilename: input.attachmentFilename,
      driveFileId: input.driveFileId,
      processedAt: input.processedAt,
      processingResult: "SUCCESS",
      newFingerprint,
    });
  }

  const current = await readLateralGmailCheckpoint();
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
    recentFingerprints: appendRecentFingerprint(
      current.recentFingerprints ?? [],
      newFingerprint
    ),
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/**
 * Strict cursor compare: (receivedAtMs, messageId) only.
 *
 * `attachmentId` is deliberately NOT part of this comparison. Gmail's
 * attachmentId is not guaranteed stable across separate `messages.get()`
 * calls for the very same message/attachment — a fresh fetch of an
 * already-checkpointed message can return a different-looking attachmentId
 * that would otherwise sort lexicographically after the one stored at
 * checkpoint time, spuriously re-admitting an already-processed message as
 * "new" (confirmed live, 2026-09-21). When receivedAtMs and messageId both
 * match the checkpoint exactly, this is unambiguously the same message —
 * there is nothing left to tie-break on.
 *
 * Positive means `candidate` is strictly after `cursor`.
 */
export function compareLateralGmailCursor(
  candidate: LateralGmailCheckpointCursor,
  cursor: LateralGmailCheckpointCursor
): number {
  if (candidate.receivedAtMs !== cursor.receivedAtMs) {
    return candidate.receivedAtMs - cursor.receivedAtMs;
  }
  return candidate.messageId.localeCompare(cursor.messageId);
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

/**
 * True when `candidate`'s content (filename+size fingerprint) matches a
 * recently-processed entry in the checkpoint's bounded history — catches a
 * same-content duplicate arriving under a DIFFERENT Gmail messageId (e.g. a
 * forwarded copy), which `isAfterLateralGmailCheckpoint`'s single cursor
 * cannot recognize on its own (confirmed live, 2026-09-21: two distinct
 * messageIds carried the same stale attachment, seconds apart).
 */
export function isKnownProcessedLateralFingerprint(
  candidate: { attachmentName: string; size: number },
  checkpoint: LateralGmailCheckpoint
): boolean {
  const fingerprint = attachmentFingerprint({
    datasetName: "Lateral",
    attachmentName: candidate.attachmentName,
    size: candidate.size,
  });
  return (checkpoint.recentFingerprints ?? []).some(
    (entry) => entry.fingerprint === fingerprint
  );
}
