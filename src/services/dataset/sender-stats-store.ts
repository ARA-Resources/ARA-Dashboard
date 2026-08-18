import fs from "node:fs/promises";
import path from "node:path";
import { readDatasetSetup } from "@/services/dataset/secure-store";
import { DATASET_SYNC_NAMES } from "@/types/dataset-sync";
import type { DatasetSetupConfig } from "@/types/dataset-setup";
import {
  senderStatsKey,
  type DatasetSenderStats,
  type SenderStatsRecord,
  type SenderStatsStore,
} from "@/types/sender-stats";

const STORE_PATH = path.join(process.cwd(), ".data", "sender-stats.json");

async function readStore(): Promise<SenderStatsStore> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as SenderStatsStore;
    if (parsed?.version === 1 && parsed.records) return parsed;
  } catch {
    // missing or invalid
  }
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    records: {},
  };
}

async function writeStore(store: SenderStatsStore) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(
    STORE_PATH,
    JSON.stringify(
      { ...store, updatedAt: new Date().toISOString() },
      null,
      2
    ),
    "utf8"
  );
}

function emptyRecord(
  datasetName: string,
  email: string
): SenderStatsRecord {
  return {
    datasetName,
    email: email.trim().toLowerCase(),
    lastEmailReceived: null,
    lastSuccessfulDownload: null,
    filesDownloaded: 0,
    downloadAttempts: 0,
    successfulDownloads: 0,
  };
}

function successRate(record: SenderStatsRecord): number {
  if (record.downloadAttempts <= 0) return 0;
  return Math.round(
    (record.successfulDownloads / record.downloadAttempts) * 100
  );
}

/** Extract bare email from `Name <email@x.com>` or plain address. */
export function extractEmailAddress(fromHeader: string): string | null {
  const angle = fromHeader.match(/<([^>]+)>/);
  const candidate = (angle?.[1] ?? fromHeader).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) return null;
  return candidate;
}

export async function recordSenderEmailReceived(input: {
  datasetName: string;
  senderHeader: string;
  receivedAt: string;
}) {
  const email = extractEmailAddress(input.senderHeader);
  if (!email) return;
  const store = await readStore();
  const key = senderStatsKey(input.datasetName, email);
  const prior = store.records[key] ?? emptyRecord(input.datasetName, email);
  const nextReceived =
    !prior.lastEmailReceived ||
    new Date(input.receivedAt).getTime() >=
      new Date(prior.lastEmailReceived).getTime()
      ? input.receivedAt
      : prior.lastEmailReceived;
  store.records[key] = {
    ...prior,
    lastEmailReceived: nextReceived,
  };
  await writeStore(store);
}

export async function recordSenderDownloadAttempt(input: {
  datasetName: string;
  senderHeader: string;
  success: boolean;
  at?: string;
}) {
  const email = extractEmailAddress(input.senderHeader);
  if (!email) return;
  const at = input.at ?? new Date().toISOString();
  const store = await readStore();
  const key = senderStatsKey(input.datasetName, email);
  const prior = store.records[key] ?? emptyRecord(input.datasetName, email);
  store.records[key] = {
    ...prior,
    downloadAttempts: prior.downloadAttempts + 1,
    successfulDownloads: prior.successfulDownloads + (input.success ? 1 : 0),
    filesDownloaded: prior.filesDownloaded + (input.success ? 1 : 0),
    lastSuccessfulDownload: input.success
      ? at
      : prior.lastSuccessfulDownload,
    lastEmailReceived: prior.lastEmailReceived ?? at,
  };
  await writeStore(store);
}

export async function listSenderStatistics(
  _setup?: DatasetSetupConfig | null
): Promise<DatasetSenderStats[]> {
  // Sender-based filtering was removed; stats API kept for compatibility.
  void _setup;
  return [];
}
