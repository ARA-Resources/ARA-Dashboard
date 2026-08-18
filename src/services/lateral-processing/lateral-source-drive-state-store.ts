/**
 * Lateral source Excel Drive state (separate from final Gmail checkpoint).
 *
 * Tracks the last verified uploaded SOURCE workbook File ID so the next run
 * can delete ONLY that previous source file after a new upload is verified.
 * Never stores OAuth tokens. Never tracks the Master XLSM as a deletable source.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isPostgresMode } from "@/lib/persistence/persistence-mode";
import { getLateralSourceDriveStateStore } from "@/lib/persistence/store-factory";

export interface LateralSourceDriveFileRef {
  driveFileId: string;
  fileName: string;
  messageId: string | null;
  receivedAt: string | null;
  uploadedAt: string;
}

export interface LateralSourceDriveState {
  version: 1;
  /** Last verified source Excel on Drive (current processing file). */
  currentSource: LateralSourceDriveFileRef | null;
  /**
   * Previous source File IDs that still need cleanup after a failed delete.
   * Never includes the currentSource id or the Master Workbook id.
   */
  pendingCleanupFileIds: string[];
  updatedAt: string;
}

const STORE_PATH = path.join(
  process.cwd(),
  ".data",
  "lateral-source-drive-state.json"
);

function emptyState(): LateralSourceDriveState {
  return {
    version: 1,
    currentSource: null,
    pendingCleanupFileIds: [],
    updatedAt: new Date().toISOString(),
  };
}

export async function readLateralSourceDriveState(): Promise<LateralSourceDriveState> {
  if (isPostgresMode()) return getLateralSourceDriveStateStore().read();
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<LateralSourceDriveState>;
    const current =
      parsed.currentSource &&
      typeof parsed.currentSource === "object" &&
      typeof parsed.currentSource.driveFileId === "string" &&
      parsed.currentSource.driveFileId.trim()
        ? {
            driveFileId: parsed.currentSource.driveFileId.trim(),
            fileName:
              typeof parsed.currentSource.fileName === "string"
                ? parsed.currentSource.fileName
                : "",
            messageId:
              typeof parsed.currentSource.messageId === "string"
                ? parsed.currentSource.messageId
                : null,
            receivedAt:
              typeof parsed.currentSource.receivedAt === "string"
                ? parsed.currentSource.receivedAt
                : null,
            uploadedAt:
              typeof parsed.currentSource.uploadedAt === "string"
                ? parsed.currentSource.uploadedAt
                : new Date().toISOString(),
          }
        : null;
    const pending = Array.isArray(parsed.pendingCleanupFileIds)
      ? parsed.pendingCleanupFileIds
          .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
          .map((id) => id.trim())
      : [];
    return {
      version: 1,
      currentSource: current,
      pendingCleanupFileIds: Array.from(new Set(pending)),
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
    };
  } catch {
    return emptyState();
  }
}

export async function writeLateralSourceDriveState(
  next: LateralSourceDriveState
): Promise<LateralSourceDriveState> {
  if (isPostgresMode()) return getLateralSourceDriveStateStore().write(next);
  const normalized: LateralSourceDriveState = {
    version: 1,
    currentSource: next.currentSource,
    pendingCleanupFileIds: Array.from(
      new Set(
        (next.pendingCleanupFileIds ?? []).filter(
          (id) =>
            id &&
            (!next.currentSource || id !== next.currentSource.driveFileId)
        )
      )
    ),
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}
