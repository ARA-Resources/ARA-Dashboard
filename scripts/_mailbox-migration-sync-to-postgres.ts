/**
 * Sync local file OAuth/setup/checkpoint → Postgres (production parity).
 * Does not print tokens/secrets.
 */
import fs from "node:fs/promises";
import path from "node:path";

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

async function withEnv(
  patch: Record<string, string | undefined>,
  fn: () => Promise<unknown>
) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function main() {
  await loadEnvLocal();
  const bakPath = path.join(
    process.cwd(),
    ".data/mailbox-migration-backups/20260825-134606/env.local.bak"
  );
  const bak = await fs.readFile(bakPath, "utf8");
  for (const line of bak.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    if (k === "ARA_SETUP_SECRET" || k === "ARA_DATASET_SETUP_SECRET") {
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      process.env[k] = v;
    }
  }

  const { resetStoreFactory } = await import(
    "../src/lib/persistence/store-factory"
  );

  const fileAuth = await withEnv(
    {
      ARA_PERSISTENCE: "file",
      ARA_DATASET_SETUP_SECRET: undefined,
      ARA_SETUP_SECRET: undefined,
    },
    async () => {
      resetStoreFactory();
      const oauth = await import("../src/services/gmail/oauth");
      const setup = await import("../src/services/dataset/secure-store");
      const cp = await import(
        "../src/services/lateral-processing/lateral-gmail-checkpoint-store"
      );
      return {
        auth: await oauth.readGmailAuth(),
        setup: await setup.readDatasetSetup(),
        checkpoint: await cp.readLateralGmailCheckpoint(),
      };
    }
  );

  if (!fileAuth.auth?.email) {
    throw new Error("Local OAuth not connected — cannot sync.");
  }

  await withEnv(
    {
      ARA_PERSISTENCE: "postgres",
      ARA_DATASET_SETUP_SECRET: undefined,
    },
    async () => {
      resetStoreFactory();
      const oauth = await import("../src/services/gmail/oauth");
      const setup = await import("../src/services/dataset/secure-store");
      const cp = await import(
        "../src/services/lateral-processing/lateral-gmail-checkpoint-store"
      );

      if (fileAuth.setup) {
        await setup.writeDatasetSetup(fileAuth.setup);
      }
      await oauth.writeGmailAuth(fileAuth.auth!);

      const c = fileAuth.checkpoint;
      if (c.messageId && c.receivedAtMs != null && c.attachmentId) {
        await cp.advanceLateralGmailCheckpoint({
          messageId: c.messageId,
          attachmentId: c.attachmentId,
          receivedAt: c.receivedAt ?? new Date(c.receivedAtMs).toISOString(),
          receivedAtMs: c.receivedAtMs,
          attachmentFilename: c.attachmentFilename ?? "unknown.xlsx",
          driveFileId: c.driveFileId ?? "unknown",
          processedAt: c.processedAt ?? new Date().toISOString(),
          processingResult: "SUCCESS",
        });
      }

      const pgAuth = await oauth.readGmailAuth();
      const pgSetup = await setup.readDatasetSetup();
      const pgCp = await cp.readLateralGmailCheckpoint();

      console.log(
        JSON.stringify(
          {
            synced: true,
            oauthEmail: pgAuth?.email ?? null,
            setupGmail: pgSetup?.gmailAddress ?? null,
            checkpointMessageId: pgCp.messageId,
            checkpointReceivedAt: pgCp.receivedAt,
          },
          null,
          2
        )
      );
    }
  );
}

main().catch((e) => {
  console.error("STOP:", e instanceof Error ? e.message : e);
  process.exit(1);
});
