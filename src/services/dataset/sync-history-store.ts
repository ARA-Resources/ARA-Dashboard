import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  SyncHistoryEntry,
  SyncHistoryStore,
  SyncHistoryStatus,
  SyncHistoryTrigger,
} from "@/types/sync-history";
import type {
  DatasetSyncItemResult,
  DatasetSyncResult,
} from "@/types/dataset-sync";
import { DATASET_LOG_DIR } from "@/services/dataset/paths";

const STORE_PATH = path.join(process.cwd(), ".data", "sync-history.json");
const MAX_ENTRIES = 500;

async function readStore(): Promise<SyncHistoryStore> {
  try {
    const raw = (await fs.readFile(STORE_PATH, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as SyncHistoryStore;
    if (!parsed || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] };
    }
    return { version: 1, entries: parsed.entries };
  } catch {
    return { version: 1, entries: [] };
  }
}

async function writeStore(store: SyncHistoryStore) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

function mapItemStatus(status: DatasetSyncItemResult["status"]): SyncHistoryStatus {
  switch (status) {
    case "uploaded_drive":
    case "promoted":
    case "validated":
    case "downloaded":
      return "success";
    case "stored_temp":
      return "updated";
    case "upload_failed":
    case "validation_failed":
    case "download_failed":
      return "failed";
    case "skipped_duplicate":
    case "skipped_superseded":
    case "unmapped":
      return "skipped";
    default:
      return "partial";
  }
}

function shouldRecordItem(item: DatasetSyncItemResult): boolean {
  // Prefer actionable outcomes; skip pure duplicate noise unless failed
  if (
    item.status === "skipped_duplicate" ||
    item.status === "skipped_superseded"
  ) {
    return false;
  }
  return true;
}

export function buildSyncHistoryEntries(input: {
  runId: string;
  trigger: SyncHistoryTrigger;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  result: DatasetSyncResult;
  downloadedFrom: string;
  uploadedTo: string;
}): SyncHistoryEntry[] {
  const logDay = input.finishedAt.slice(0, 10);
  const entries: SyncHistoryEntry[] = [];

  const actionable = input.result.items.filter(shouldRecordItem);

  if (actionable.length === 0) {
    entries.push({
      id: randomUUID(),
      runId: input.runId,
      dataset: "All",
      syncTime: input.finishedAt,
      downloadedFrom: input.downloadedFrom,
      uploadedTo: input.uploadedTo,
      fileName: "—",
      durationMs: input.durationMs,
      status: "success",
      errors: null,
      trigger: input.trigger,
      logDay,
      itemStatus: "no_new_attachments",
    });
    return entries;
  }

  for (const item of actionable) {
    const dataset = item.datasetName?.trim() || "Unknown";
    const status = mapItemStatus(item.status);
    entries.push({
      id: randomUUID(),
      runId: input.runId,
      dataset,
      syncTime: input.finishedAt,
      downloadedFrom: input.downloadedFrom,
      uploadedTo: input.uploadedTo,
      fileName: item.renamedFile || item.originalName || "—",
      durationMs: input.durationMs,
      status,
      errors: item.error?.trim() || null,
      trigger: input.trigger,
      logDay,
      itemStatus: item.status,
      driveFileId: item.driveFileId ?? null,
      messageId: item.messageId,
      attachmentId: item.attachmentId,
      originalName: item.originalName,
      fileSize: item.fileSize ?? item.driveFileSize ?? null,
      checksumSha256: item.checksumSha256 ?? null,
    });
  }

  return entries;
}

export async function appendSyncHistoryEntries(
  entries: SyncHistoryEntry[]
): Promise<SyncHistoryEntry[]> {
  if (entries.length === 0) return [];
  const store = await readStore();
  store.entries = [...entries, ...store.entries].slice(0, MAX_ENTRIES);
  await writeStore(store);
  return entries;
}

export async function listSyncHistory(limit = 100): Promise<SyncHistoryEntry[]> {
  const store = await readStore();
  return store.entries.slice(0, limit);
}

export async function getSyncHistoryEntry(
  id: string
): Promise<SyncHistoryEntry | null> {
  const store = await readStore();
  return store.entries.find((entry) => entry.id === id) ?? null;
}

export function syncLogFilePath(logDay: string) {
  return path.join(DATASET_LOG_DIR, `dataset-sync-${logDay}.jsonl`);
}

export async function readSyncLogFile(logDay: string): Promise<string | null> {
  try {
    return await fs.readFile(syncLogFilePath(logDay), "utf8");
  } catch {
    return null;
  }
}

/** Notification copy for the bell panel */
export function notificationCopyForHistoryEntry(entry: SyncHistoryEntry): {
  title: string;
  body: string;
  kind: "dataset_sync_success" | "dataset_sync_partial" | "dataset_sync_failed";
} {
  const name = entry.dataset === "All" ? "Datasets" : `${entry.dataset} dataset`;

  if (entry.status === "failed") {
    const isUpload = entry.itemStatus === "upload_failed";
    return {
      kind: "dataset_sync_failed",
      title: isUpload
        ? `${entry.dataset} dataset upload failed`
        : `${entry.dataset} dataset sync failed`,
      body: entry.errors || `${name} failed during automated sync.`,
    };
  }

  if (entry.status === "updated" || entry.itemStatus === "promoted") {
    return {
      kind: "dataset_sync_success",
      title: `${entry.dataset} dataset updated`,
      body: `${entry.fileName} is now the current ${entry.dataset} dataset.`,
    };
  }

  if (entry.status === "skipped") {
    return {
      kind: "dataset_sync_partial",
      title: `${entry.dataset} dataset skipped`,
      body: entry.errors || `${entry.fileName} was not applied.`,
    };
  }

  if (entry.dataset === "All") {
    return {
      kind: "dataset_sync_success",
      title: "Dataset sync completed",
      body: "No new Excel attachments. Current datasets are up to date.",
    };
  }

  return {
    kind: "dataset_sync_success",
    title: `${entry.dataset} dataset synced successfully`,
    body: `${entry.fileName} downloaded from Gmail and uploaded to Drive.`,
  };
}
