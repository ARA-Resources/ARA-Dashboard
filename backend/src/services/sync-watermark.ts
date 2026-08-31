import fs from "node:fs/promises";
import path from "node:path";
import { isPostgresMode } from "../config/persistence-mode.js";
import { repoDataDir } from "../config/repo-root.js";
import { queryRows } from "../db.js";

export type DatasetSyncWatermark = {
  version: 1;
  lastSuccessfulSyncAt: string | null;
  lastSuccessfulSyncAtMs: number | null;
  lastTrigger: "scheduler" | "manual" | "api" | null;
  updatedAt: string;
};

function emptyWatermark(): DatasetSyncWatermark {
  return {
    version: 1,
    lastSuccessfulSyncAt: null,
    lastSuccessfulSyncAtMs: null,
    lastTrigger: null,
    updatedAt: new Date().toISOString(),
  };
}

function parseWatermarkFile(raw: string): DatasetSyncWatermark {
  const parsed = JSON.parse(raw) as Partial<DatasetSyncWatermark>;
  if (parsed?.version !== 1) return emptyWatermark();
  const at =
    typeof parsed.lastSuccessfulSyncAt === "string"
      ? parsed.lastSuccessfulSyncAt
      : null;
  const ms =
    typeof parsed.lastSuccessfulSyncAtMs === "number" &&
    Number.isFinite(parsed.lastSuccessfulSyncAtMs)
      ? parsed.lastSuccessfulSyncAtMs
      : at
        ? Date.parse(at)
        : null;
  return {
    version: 1,
    lastSuccessfulSyncAt: at,
    lastSuccessfulSyncAtMs:
      ms != null && Number.isFinite(ms) ? ms : null,
    lastTrigger:
      parsed.lastTrigger === "scheduler" ||
      parsed.lastTrigger === "manual" ||
      parsed.lastTrigger === "api"
        ? parsed.lastTrigger
        : null,
    updatedAt:
      typeof parsed.updatedAt === "string"
        ? parsed.updatedAt
        : new Date().toISOString(),
  };
}

async function readSyncWatermarkFromPostgres(): Promise<DatasetSyncWatermark> {
  // Matches Next PostgresSyncWatermarkStore.read() — ensures a row exists.
  await queryRows(
    "INSERT INTO sync_watermark DEFAULT VALUES ON CONFLICT DO NOTHING"
  );
  const rows = await queryRows<{
    last_successful_sync_at: Date | string | null;
    last_successful_sync_ms: number | bigint | null;
    last_trigger: string | null;
    updated_at: Date | string | null;
  }>("SELECT * FROM sync_watermark ORDER BY id LIMIT 1");
  const row = rows[0];
  if (!row) return emptyWatermark();
  const at =
    row.last_successful_sync_at instanceof Date
      ? row.last_successful_sync_at.toISOString()
      : typeof row.last_successful_sync_at === "string"
        ? row.last_successful_sync_at
        : null;
  const ms =
    typeof row.last_successful_sync_ms === "bigint"
      ? Number(row.last_successful_sync_ms)
      : typeof row.last_successful_sync_ms === "number"
        ? row.last_successful_sync_ms
        : null;
  const trigger =
    row.last_trigger === "scheduler" ||
    row.last_trigger === "manual" ||
    row.last_trigger === "api"
      ? row.last_trigger
      : null;
  return {
    version: 1,
    lastSuccessfulSyncAt: at,
    lastSuccessfulSyncAtMs: ms,
    lastTrigger: trigger,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : typeof row.updated_at === "string"
          ? row.updated_at
          : new Date().toISOString(),
  };
}

async function readSyncWatermarkFromFile(): Promise<DatasetSyncWatermark> {
  const storePath = path.join(repoDataDir(), "sync-watermark.json");
  try {
    const raw = await fs.readFile(storePath, "utf8");
    return parseWatermarkFile(raw);
  } catch {
    return emptyWatermark();
  }
}

/** Read-only sync watermark — matches Next readSyncWatermark(). */
export async function readSyncWatermark(): Promise<DatasetSyncWatermark> {
  if (isPostgresMode()) {
    try {
      return await readSyncWatermarkFromPostgres();
    } catch {
      return readSyncWatermarkFromFile();
    }
  }
  return readSyncWatermarkFromFile();
}
