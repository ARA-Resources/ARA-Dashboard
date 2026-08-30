import fs from "node:fs/promises";
import path from "node:path";
import { readEncryptedJson, writeEncryptedJson } from "@/services/dataset/encrypted-json-store";

export type ExecutiveIngestionPhase =
  | "idle"
  | "fetching"
  | "downloading"
  | "validating"
  | "uploading"
  | "success"
  | "error"
  | "skipped_duplicate"
  | "config_incomplete";

export interface ExecutiveIngestionSourceState {
  updatedAt: string;
  lastSuccess?: {
    processedAt: string;
    messageId: string;
    attachmentId: string;
    attachmentName: string;
    checksumSha256: string;
    receivedAt?: string;
    driveFileId?: string | null;
    driveWebViewLink?: string | null;
    localCurrentRelative?: string | null;
    sizeBytes?: number;
  };
  lastAttempt?: {
    at: string;
    phase: ExecutiveIngestionPhase;
    ok: boolean;
    message: string;
    messageId?: string;
    attachmentName?: string;
  };
}

const STORE_NAME = "executive-ingestion-state.enc.json";

function emptyState(): ExecutiveIngestionSourceState {
  return { updatedAt: new Date().toISOString() };
}

export async function readExecutiveIngestionState(): Promise<ExecutiveIngestionSourceState> {
  const stored = await readEncryptedJson<ExecutiveIngestionSourceState>(STORE_NAME);
  return stored ?? emptyState();
}

export async function writeExecutiveIngestionState(
  next: ExecutiveIngestionSourceState
): Promise<void> {
  await writeEncryptedJson(STORE_NAME, {
    ...next,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Plain JSON status for UI (no secrets). Local relative path only.
 */
export async function getExecutiveIngestionPublicStatus(): Promise<{
  hasPriorSuccess: boolean;
  lastSuccess: ExecutiveIngestionSourceState["lastSuccess"] | null;
  lastAttempt: ExecutiveIngestionSourceState["lastAttempt"] | null;
}> {
  const state = await readExecutiveIngestionState();
  return {
    hasPriorSuccess: Boolean(state.lastSuccess?.checksumSha256),
    lastSuccess: state.lastSuccess ?? null,
    lastAttempt: state.lastAttempt ?? null,
  };
}

export function executiveTempDir(): string {
  return path.join(process.cwd(), ".data", "datasets", "temp", "Executive");
}

export function executiveCurrentDir(): string {
  return path.join(process.cwd(), ".data", "datasets", "current", "Executive");
}

export async function ensureExecutiveStagingDirs(): Promise<void> {
  await fs.mkdir(executiveTempDir(), { recursive: true });
  await fs.mkdir(executiveCurrentDir(), { recursive: true });
}
