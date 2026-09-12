/**
 * Executive-only sync history (Phase E8). Mirrors
 * `lateral-sync-history-store.ts` exactly — own table (`executive_sync_history`),
 * own file (`.data/executive-sync-history.json`), never shares rows with
 * Lateral's history.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isPostgresMode } from "@/lib/persistence/persistence-mode";
import { getExecutiveSyncHistoryStore } from "@/lib/persistence/store-factory";
import type {
  ExecutiveSyncHistoryEntry,
  ExecutiveSyncHistoryResult,
} from "@/types/executive-sync-history";

export type { ExecutiveSyncHistoryEntry, ExecutiveSyncHistoryResult };

interface ExecutiveSyncHistoryStore {
  version: 1;
  entries: ExecutiveSyncHistoryEntry[];
}

const STORE_PATH = path.join(
  process.cwd(),
  ".data",
  "executive-sync-history.json"
);
const MAX_ENTRIES = 300;

async function readStore(): Promise<ExecutiveSyncHistoryStore> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as ExecutiveSyncHistoryStore;
    if (!parsed || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] };
    }
    return { version: 1, entries: parsed.entries };
  } catch {
    return { version: 1, entries: [] };
  }
}

async function writeStore(store: ExecutiveSyncHistoryStore): Promise<void> {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

/** Public list — never includes tokens or credentials. */
export async function listExecutiveSyncHistory(
  limit = 100
): Promise<ExecutiveSyncHistoryEntry[]> {
  if (isPostgresMode()) return getExecutiveSyncHistoryStore().list(limit);
  const store = await readStore();
  return store.entries
    .slice()
    .sort((a, b) => b.syncTime.localeCompare(a.syncTime))
    .slice(0, Math.max(1, Math.min(500, limit)));
}

export async function appendExecutiveSyncHistory(
  input: Omit<ExecutiveSyncHistoryEntry, "id">
): Promise<ExecutiveSyncHistoryEntry> {
  if (isPostgresMode()) return getExecutiveSyncHistoryStore().append(input);
  const entry: ExecutiveSyncHistoryEntry = {
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
