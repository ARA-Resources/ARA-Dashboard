/**
 * Executive Gmail checkpoint (Phase E1 — foundations only).
 *
 * Mirrors `lateral-gmail-checkpoint-store.ts` exactly. Fully independent of
 * Lateral's checkpoint:
 *   - Postgres mode: same `gmail_checkpoint` table, but a SEPARATE row,
 *     keyed by `account_email = 'executive'` (Lateral uses 'default').
 *     `PostgresGmailCheckpointStore.read/advance` already accept an
 *     `accountEmail` parameter — no schema change needed.
 *   - File mode: separate file, `.data/executive-gmail-checkpoint.json`
 *     (Lateral uses `.data/lateral-gmail-checkpoint.json`).
 *
 * The `LateralGmailCheckpoint` / cursor types are reused as-is — the shape
 * (messageId/attachmentId/receivedAt/driveFileId/processingResult) is
 * checkpoint-generic, not Lateral-specific; only the field names carry the
 * historical "Lateral" prefix from when this was the only pipeline.
 *
 * No pipeline code calls this yet — that lands in Phase E2 (Gmail ingestion).
 */
import fs from "node:fs/promises";
import path from "node:path";
import type {
  LateralCheckpointProcessingResult as ExecutiveCheckpointProcessingResult,
  LateralGmailCheckpoint as ExecutiveGmailCheckpoint,
  LateralGmailCheckpointCursor as ExecutiveGmailCheckpointCursor,
} from "@/types/lateral-gmail-checkpoint";
import { isPostgresMode } from "@/lib/persistence/persistence-mode";
import { getGmailCheckpointStore } from "@/lib/persistence/store-factory";

export type {
  ExecutiveCheckpointProcessingResult,
  ExecutiveGmailCheckpoint,
  ExecutiveGmailCheckpointCursor,
};

/** Distinguishes this checkpoint's row/file from Lateral's. */
export const EXECUTIVE_GMAIL_CHECKPOINT_ACCOUNT = "executive" as const;

const STORE_PATH = path.join(
  process.cwd(),
  ".data",
  "executive-gmail-checkpoint.json"
);

function emptyCheckpoint(): ExecutiveGmailCheckpoint {
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

export async function readExecutiveGmailCheckpoint(): Promise<ExecutiveGmailCheckpoint> {
  if (isPostgresMode()) {
    return getGmailCheckpointStore().read(EXECUTIVE_GMAIL_CHECKPOINT_ACCOUNT);
  }
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<ExecutiveGmailCheckpoint>;
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
 * Persist a SUCCESS checkpoint. Call ONLY after all pipeline gates pass
 * (mirrors `advanceFinalLateralGmailCheckpoint` — the Executive equivalent
 * lands in Phase E4). Do not call on any failure.
 */
export async function advanceExecutiveGmailCheckpoint(input: {
  messageId: string;
  attachmentId: string;
  receivedAt: string;
  receivedAtMs: number;
  attachmentFilename: string;
  driveFileId: string;
  processedAt?: string;
  processingResult: ExecutiveCheckpointProcessingResult;
}): Promise<ExecutiveGmailCheckpoint> {
  if (isPostgresMode()) {
    return getGmailCheckpointStore().advance({
      ...input,
      processingResult: "SUCCESS",
      accountEmail: EXECUTIVE_GMAIL_CHECKPOINT_ACCOUNT,
    });
  }
  if (input.processingResult !== "SUCCESS") {
    throw new Error(
      "Executive Gmail checkpoint may only be written with processingResult=SUCCESS."
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
      "Executive Gmail checkpoint requires Message ID, email timestamp, original attachment filename, and Drive file ID."
    );
  }

  const processedAt = input.processedAt ?? new Date().toISOString();
  const next: ExecutiveGmailCheckpoint = {
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
 * Identical logic to `compareLateralGmailCursor` — duplicated (not imported)
 * so Phase E2+ can evolve Executive's dedup rules independently of Lateral's.
 */
export function compareExecutiveGmailCursor(
  candidate: ExecutiveGmailCheckpointCursor,
  cursor: ExecutiveGmailCheckpointCursor
): number {
  if (candidate.receivedAtMs !== cursor.receivedAtMs) {
    return candidate.receivedAtMs - cursor.receivedAtMs;
  }
  const byMessage = candidate.messageId.localeCompare(cursor.messageId);
  if (byMessage !== 0) return byMessage;
  return candidate.attachmentId.localeCompare(cursor.attachmentId);
}

export function isAfterExecutiveGmailCheckpoint(
  candidate: ExecutiveGmailCheckpointCursor,
  checkpoint: ExecutiveGmailCheckpoint
): boolean {
  if (!checkpoint.messageId || checkpoint.receivedAtMs == null) {
    return true;
  }
  return (
    compareExecutiveGmailCursor(candidate, {
      messageId: checkpoint.messageId,
      attachmentId: checkpoint.attachmentId || "",
      receivedAtMs: checkpoint.receivedAtMs,
    }) > 0
  );
}
