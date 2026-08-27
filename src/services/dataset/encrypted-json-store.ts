import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getDatasetSetupSecret,
  isProductionEnv,
  missingConfigError,
} from "@/lib/config/runtime";
import { isPostgresMode } from "@/lib/persistence/persistence-mode";
import { getEncryptedConfigStore } from "@/lib/persistence/store-factory";

function resolveEncryptedStoreDir() {
  const isServerlessRuntime =
    Boolean(process.env.VERCEL) ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
    process.cwd().startsWith("/var/task");

  if (isServerlessRuntime) {
    return path.join(os.tmpdir(), "ara-dashboard", ".data");
  }
  return path.join(process.cwd(), ".data");
}

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

export async function readEncryptedJson<T>(fileName: string): Promise<T | null> {
  if (isPostgresMode()) {
    try {
      const raw = await getEncryptedConfigStore().readRawEnvelope(fileName);
      if (raw) {
        const envelope = JSON.parse(raw) as {
          alg: string;
          iv: string;
          tag: string;
          ciphertext: string;
        };
        if (envelope.alg === "aes-256-gcm") {
          return JSON.parse(decryptPayload(envelope)) as T;
        }
      }
    } catch {
      // Fall through to local .data file (common during postgres migration).
    }
  }
  try {
    const raw = await fs.readFile(
      path.join(resolveEncryptedStoreDir(), fileName),
      "utf8"
    );
    const envelope = JSON.parse(raw) as {
      alg: string;
      iv: string;
      tag: string;
      ciphertext: string;
    };
    if (envelope.alg !== "aes-256-gcm") return null;
    return JSON.parse(decryptPayload(envelope)) as T;
  } catch {
    return null;
  }
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
    await getEncryptedConfigStore().writeRawEnvelope(fileName, envelopeStr);
    return;
  }
  const storeDir = resolveEncryptedStoreDir();
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(path.join(storeDir, fileName), envelopeStr, "utf8");
}

export async function deleteEncryptedJson(fileName: string): Promise<void> {
  if (isPostgresMode()) {
    await getEncryptedConfigStore().deleteKey(fileName);
    return;
  }
  try {
    await fs.unlink(path.join(resolveEncryptedStoreDir(), fileName));
  } catch {
    // ignore
  }
}
