/**
 * Stage 16: read-only encrypted JSON store — matches Next encrypted-json-store.ts.
 * Decrypt only; no writes.
 */
import { createDecipheriv, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isPostgresMode } from "../config/persistence-mode.js";
import { repoDataDir } from "../config/repo-root.js";
import {
  getDatasetSetupSecret,
  isProductionEnv,
  missingConfigError,
} from "../config/runtime.js";
import { queryRows } from "../db.js";

type EncryptedEnvelope = {
  alg: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

function resolveSecretKey(): Buffer {
  const secret = getDatasetSetupSecret();
  if (!secret) {
    if (isProductionEnv()) {
      throw missingConfigError("ARA_DATASET_SETUP_SECRET");
    }
    console.warn(
      "[config] ARA_DATASET_SETUP_SECRET is missing; using a development-only encryption key. Do not use this in production."
    );
    return createHash("sha256")
      .update("ara-local-dev-dataset-setup-key-change-me")
      .digest();
  }
  return createHash("sha256").update(secret).digest();
}

function decryptPayload(payload: {
  iv: string;
  tag: string;
  ciphertext: string;
}): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    resolveSecretKey(),
    Buffer.from(payload.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function parseAndDecrypt<T>(raw: string): T | null {
  const envelope = JSON.parse(raw) as EncryptedEnvelope;
  if (envelope.alg !== "aes-256-gcm") return null;
  return JSON.parse(decryptPayload(envelope)) as T;
}

async function readRawEnvelopeFromPostgres(
  fileName: string
): Promise<string | null> {
  try {
    const rows = await queryRows<{ encrypted_value: string }>(
      "SELECT encrypted_value FROM app_config WHERE key = $1 LIMIT 1",
      [fileName]
    );
    return rows[0]?.encrypted_value ?? null;
  } catch {
    return null;
  }
}

async function readRawEnvelopeFromFile(
  fileName: string
): Promise<string | null> {
  try {
    return await fs.readFile(path.join(repoDataDir(), fileName), "utf8");
  } catch {
    return null;
  }
}

/**
 * Read and decrypt an encrypted JSON blob. Matches Next readEncryptedJson semantics.
 */
export async function readEncryptedJson<T>(
  fileName: string
): Promise<T | null> {
  if (isPostgresMode()) {
    try {
      const raw = await readRawEnvelopeFromPostgres(fileName);
      if (raw) {
        return parseAndDecrypt<T>(raw);
      }
    } catch {
      // Fall through to local .data file (common during postgres migration).
    }
  }
  try {
    const raw = await readRawEnvelopeFromFile(fileName);
    if (!raw) return null;
    return parseAndDecrypt<T>(raw);
  } catch {
    return null;
  }
}

/** Diagnostics — path only, never log contents. */
export function getEncryptedStorePathForDiagnostics(fileName: string): string {
  return path.join(repoDataDir(), fileName);
}
