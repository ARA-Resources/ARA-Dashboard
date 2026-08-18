import fs from "node:fs/promises";
import path from "node:path";
import { isPostgresMode } from "@/lib/persistence/persistence-mode";
import { getSyncWatermarkStore } from "@/lib/persistence/store-factory";

const STORE_PATH = path.join(
  process.cwd(),
  ".data",
  "sync-watermark.json"
);

export interface DatasetSyncWatermark {
  version: 1;
  /** ISO timestamp of the last successful automated sync completion */
  lastSuccessfulSyncAt: string | null;
  /** Epoch ms mirror of lastSuccessfulSyncAt */
  lastSuccessfulSyncAtMs: number | null;
  /** Trigger that advanced the watermark */
  lastTrigger: "scheduler" | "manual" | "api" | null;
  updatedAt: string;
}

function emptyWatermark(): DatasetSyncWatermark {
  return {
    version: 1,
    lastSuccessfulSyncAt: null,
    lastSuccessfulSyncAtMs: null,
    lastTrigger: null,
    updatedAt: new Date().toISOString(),
  };
}

export async function readSyncWatermark(): Promise<DatasetSyncWatermark> {
  if (isPostgresMode()) return getSyncWatermarkStore().read();
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
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
  } catch {
    return emptyWatermark();
  }
}

export async function writeSyncWatermark(
  partial: Partial<
    Pick<
      DatasetSyncWatermark,
      "lastSuccessfulSyncAt" | "lastSuccessfulSyncAtMs" | "lastTrigger"
    >
  >
): Promise<DatasetSyncWatermark> {
  if (isPostgresMode()) return getSyncWatermarkStore().write(partial);
  const prior = await readSyncWatermark();
  const at =
    partial.lastSuccessfulSyncAt ?? prior.lastSuccessfulSyncAt ?? null;
  const ms =
    partial.lastSuccessfulSyncAtMs ??
    (at ? Date.parse(at) : null) ??
    prior.lastSuccessfulSyncAtMs;

  const next: DatasetSyncWatermark = {
    version: 1,
    lastSuccessfulSyncAt: at,
    lastSuccessfulSyncAtMs:
      ms != null && Number.isFinite(ms) ? ms : null,
    lastTrigger: partial.lastTrigger ?? prior.lastTrigger,
    updatedAt: new Date().toISOString(),
  };

  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/**
 * Advance watermark after a successful (or partial) sync.
 * Failed syncs must not move the cursor — emails stay eligible for retry.
 */
export async function markSuccessfulSync(options: {
  at?: string | Date;
  trigger: "scheduler" | "manual" | "api";
}): Promise<DatasetSyncWatermark> {
  const when =
    options.at instanceof Date
      ? options.at
      : options.at
        ? new Date(options.at)
        : new Date();
  const iso = when.toISOString();
  return writeSyncWatermark({
    lastSuccessfulSyncAt: iso,
    lastSuccessfulSyncAtMs: when.getTime(),
    lastTrigger: options.trigger,
  });
}
