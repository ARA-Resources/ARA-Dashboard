/**
 * Lateral-only sync history (no OAuth tokens / secrets).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isPostgresMode } from "@/lib/persistence/persistence-mode";
import { getLateralSyncHistoryStore } from "@/lib/persistence/store-factory";
import type {
  LateralSyncHistoryEntry,
  LateralSyncHistoryResult,
} from "@/types/lateral-sync-history";

export type { LateralSyncHistoryEntry, LateralSyncHistoryResult };

interface LateralSyncHistoryStore {
  version: 1;
  entries: LateralSyncHistoryEntry[];
}

const STORE_PATH = path.join(
  process.cwd(),
  ".data",
  "lateral-sync-history.json"
);
const MAX_ENTRIES = 300;

async function readStore(): Promise<LateralSyncHistoryStore> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as LateralSyncHistoryStore;
    if (!parsed || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] };
    }
    return { version: 1, entries: parsed.entries };
  } catch {
    return { version: 1, entries: [] };
  }
}

async function writeStore(store: LateralSyncHistoryStore): Promise<void> {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

/** Public list — never includes tokens or credentials. */
export async function listLateralSyncHistory(
  limit = 100
): Promise<LateralSyncHistoryEntry[]> {
  if (isPostgresMode()) return getLateralSyncHistoryStore().list(limit);
  const store = await readStore();
  return store.entries
    .slice()
    .sort((a, b) => b.syncTime.localeCompare(a.syncTime))
    .slice(0, Math.max(1, Math.min(500, limit)));
}

export async function appendLateralSyncHistory(
  input: Omit<LateralSyncHistoryEntry, "id">
): Promise<LateralSyncHistoryEntry> {
  if (isPostgresMode()) return getLateralSyncHistoryStore().append(input);
  const entry: LateralSyncHistoryEntry = {
    id: randomUUID(),
    syncTime: input.syncTime,
    sourceEmail: input.sourceEmail || "—",
    originalFilename: input.originalFilename || "—",
    googleDriveFileId: input.googleDriveFileId || "—",
    rowsImported: Number.isFinite(input.rowsImported) ? input.rowsImported : 0,
    newCount: Number.isFinite(input.newCount) ? input.newCount : 0,
    activeCount: Number.isFinite(input.activeCount) ? input.activeCount : 0,
    reopenCount: Number.isFinite(input.reopenCount) ? input.reopenCount : 0,
    closedCount: Number.isFinite(input.closedCount) ? input.closedCount : 0,
    result: input.result === "Success" ? "Success" : "Failed",
    error: input.error ? String(input.error).slice(0, 2000) : null,
    trigger: input.trigger,
    durationMs: Number.isFinite(input.durationMs) ? input.durationMs : 0,
  };

  const store = await readStore();
  store.entries.unshift(entry);
  store.entries = store.entries.slice(0, MAX_ENTRIES);
  await writeStore(store);
  return entry;
}
