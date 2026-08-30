/**
 * Stage 13: Dataset Sync History — FILE-BACKED read-only (same as Next).
 *
 * Authoritative paths (repo root, not backend cwd):
 *   .data/sync-history.json
 *   .data/logs/dataset-sync-{YYYY-MM-DD}.jsonl
 *
 * Does NOT use PostgreSQL dataset_sync_history.
 * Does NOT write sync-history files.
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  SyncHistoryEntry,
  SyncHistoryStore,
} from "../types/dataset-sync-history.js";

/**
 * Resolve monorepo root (directory containing `src/app`).
 * Works when cwd is repo root or backend/.
 */
export function resolveRepoRoot(): string {
  const cwd = process.cwd();
  const rootMarker = path.join("src", "app");
  if (existsSync(path.join(cwd, rootMarker))) {
    return cwd;
  }
  const parent = path.resolve(cwd, "..");
  if (existsSync(path.join(parent, rootMarker))) {
    return parent;
  }
  return cwd;
}

function dataDir(): string {
  return path.join(resolveRepoRoot(), ".data");
}

export function syncHistoryStorePath(): string {
  return path.join(dataDir(), "sync-history.json");
}

export function datasetLogDir(): string {
  return path.join(dataDir(), "logs");
}

const LOG_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

async function readStore(): Promise<SyncHistoryStore> {
  try {
    const raw = (await fs.readFile(syncHistoryStorePath(), "utf8")).replace(
      /^\uFEFF/,
      ""
    );
    const parsed = JSON.parse(raw) as SyncHistoryStore;
    if (!parsed || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] };
    }
    return { version: 1, entries: parsed.entries };
  } catch {
    return { version: 1, entries: [] };
  }
}

export async function listSyncHistory(
  limit = 100
): Promise<SyncHistoryEntry[]> {
  const store = await readStore();
  return store.entries.slice(0, limit);
}

export async function getSyncHistoryEntry(
  id: string
): Promise<SyncHistoryEntry | null> {
  const store = await readStore();
  return store.entries.find((entry) => entry.id === id) ?? null;
}

/**
 * Build log file path for a calendar day.
 * Rejects non-date logDay values (path-traversal hardening beyond Next).
 */
export function syncLogFilePath(logDay: string): string | null {
  if (!LOG_DAY_RE.test(logDay)) {
    return null;
  }
  const logDir = path.resolve(datasetLogDir());
  const candidate = path.resolve(logDir, `dataset-sync-${logDay}.jsonl`);
  const relative = path.relative(logDir, candidate);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.includes(`..${path.sep}`)
  ) {
    return null;
  }
  return candidate;
}

export async function readSyncLogFile(logDay: string): Promise<string | null> {
  const filePath = syncLogFilePath(logDay);
  if (!filePath) return null;
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Diagnostics only — never log file contents. */
export function getSyncHistoryPathsForDiagnostics(): {
  repoRoot: string;
  storePath: string;
  logDir: string;
} {
  return {
    repoRoot: resolveRepoRoot(),
    storePath: syncHistoryStorePath(),
    logDir: datasetLogDir(),
  };
}
