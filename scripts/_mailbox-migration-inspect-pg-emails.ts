/**
 * Inspect configured emails from Postgres app_config (emails only; no tokens).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, createDecipheriv } from "node:crypto";
import postgres from "postgres";

async function loadEnvLocal() {
  const content = await fs.readFile(
    path.join(process.cwd(), ".env.local"),
    "utf8"
  );
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !(k in process.env)) process.env[k] = v;
  }
}

function tryDecrypt(
  label: string,
  secret: string | undefined,
  envelope: { alg: string; iv: string; tag: string; ciphertext: string }
) {
  if (!secret) return { label, ok: false as const, reason: "missing secret" };
  try {
    const key = createHash("sha256").update(secret).digest();
    const d = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64")
    );
    d.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const out = Buffer.concat([
      d.update(Buffer.from(envelope.ciphertext, "base64")),
      d.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(out) as Record<string, unknown>;
    if ("email" in parsed) {
      return {
        label,
        ok: true as const,
        email: parsed.email ?? null,
        expectedEmail: parsed.expectedEmail ?? null,
      };
    }
    return {
      label,
      ok: true as const,
      gmailAddress: parsed.gmailAddress ?? null,
      driveAccountEmail: parsed.driveAccountEmail ?? null,
    };
  } catch (e) {
    return {
      label,
      ok: false as const,
      reason: e instanceof Error ? e.message : "decrypt failed",
    };
  }
}

async function main() {
  await loadEnvLocal();
  const url = process.env.POSTGRES_URL!;
  const sql = postgres(url, { max: 1, ssl: "require" });
  try {
    const keys = ["gmail-oauth.enc.json", "dataset-setup.enc.json"] as const;
    const report: Record<string, unknown> = {};
    for (const key of keys) {
      const rows = await sql<{ encrypted_value: string }[]>`
        SELECT encrypted_value FROM app_config WHERE key = ${key} LIMIT 1
      `;
      if (!rows[0]) {
        report[key] = { present: false };
        continue;
      }
      const envelope = JSON.parse(rows[0].encrypted_value) as {
        alg: string;
        iv: string;
        tag: string;
        ciphertext: string;
      };
      report[key] = {
        present: true,
        withDatasetSecret: tryDecrypt(
          "ARA_DATASET_SETUP_SECRET",
          process.env.ARA_DATASET_SETUP_SECRET,
          envelope
        ),
        withSetupSecret: tryDecrypt(
          "ARA_SETUP_SECRET",
          process.env.ARA_SETUP_SECRET,
          envelope
        ),
        withDevKey: tryDecrypt(
          "dev",
          "ara-local-dev-dataset-setup-key-change-me",
          envelope
        ),
      };
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
