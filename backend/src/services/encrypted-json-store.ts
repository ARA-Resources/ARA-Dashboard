/**
 * Stage 16/21: encrypted JSON store — matches Next encrypted-json-store.ts.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
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

function encryptPayload(plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", resolveSecretKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
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

async function writeRawEnvelopeToPostgres(
  fileName: string,
  envelope: string
): Promise<void> {
  await queryRows(
    `INSERT INTO app_config (key, encrypted_value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE
       SET encrypted_value = EXCLUDED.encrypted_value,
           updated_at = EXCLUDED.updated_at`,
    [fileName, envelope]
  );
}

async function deleteRawEnvelopeFromPostgres(fileName: string): Promise<void> {
  await queryRows("DELETE FROM app_config WHERE key = $1", [fileName]);
}

async function writeRawEnvelopeToFile(
  fileName: string,
  envelope: string
): Promise<void> {
  const storeDir = repoDataDir();
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(path.join(storeDir, fileName), envelope, "utf8");
}

async function deleteRawEnvelopeFromFile(fileName: string): Promise<void> {
  try {
    await fs.unlink(path.join(repoDataDir(), fileName));
  } catch {
    // ignore missing file
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

export async function writeEncryptedJson(
  fileName: string,
  value: unknown
): Promise<void> {
  const envelope = {
    alg: "aes-256-gcm" as const,
    ...encryptPayload(JSON.stringify(value)),
    savedAt: new Date().toISOString(),
  };
  const envelopeStr = JSON.stringify(envelope, null, 2);
  if (isPostgresMode()) {
    await writeRawEnvelopeToPostgres(fileName, envelopeStr);
    return;
  }
  await writeRawEnvelopeToFile(fileName, envelopeStr);
}

export async function deleteEncryptedJson(fileName: string): Promise<void> {
  if (isPostgresMode()) {
    await deleteRawEnvelopeFromPostgres(fileName);
    return;
  }
  await deleteRawEnvelopeFromFile(fileName);
}
