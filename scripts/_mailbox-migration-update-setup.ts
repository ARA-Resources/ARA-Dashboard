/**
 * Mailbox migration Steps 3–5:
 * - Update Dataset setup gmailAddress + driveAccountEmail → mis@
 * - Disconnect OAuth (local file + Postgres app_config)
 * Does NOT print secrets/tokens.
 *
 * Env GMAIL_* updates are done separately in .env.local.
 */
import fs from "node:fs/promises";
import path from "node:path";

const TARGET = "mis@araresources.com";

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
  fn: () => Promise<void>
) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function updateLocalFileSetup() {
  // Local .data encrypted with development key (prior audit).
  await withEnv(
    {
      ARA_PERSISTENCE: "file",
      ARA_DATASET_SETUP_SECRET: undefined,
      ARA_SETUP_SECRET: undefined,
    },
    async () => {
      const factory = await import("../src/lib/persistence/store-factory");
      factory.resetStoreFactory();
      const setupMod = await import("../src/services/dataset/secure-store");
      const oauthMod = await import("../src/services/gmail/oauth");
      const setup = await setupMod.readDatasetSetup();
      if (!setup) throw new Error("Local dataset setup missing.");
      const before = {
        gmailAddress: setup.gmailAddress,
        driveAccountEmail: setup.driveAccountEmail,
      };
      await setupMod.writeDatasetSetup({
        ...setup,
        gmailAddress: TARGET,
        driveAccountEmail: TARGET,
        updatedAt: new Date().toISOString(),
      });
      await oauthMod.clearGmailAuth();
      const after = await setupMod.readDatasetSetup();
      const auth = await oauthMod.readGmailAuth();
      console.log(
        JSON.stringify({
          store: "local-file",
          before,
          after: {
            gmailAddress: after?.gmailAddress ?? null,
            driveAccountEmail: after?.driveAccountEmail ?? null,
          },
          oauthCleared: auth == null,
        })
      );
    }
  );
}

async function updatePostgresSetup() {
  // Postgres app_config decrypts with ARA_SETUP_SECRET (not DATASET secret).
  await withEnv(
    {
      ARA_PERSISTENCE: "postgres",
      ARA_DATASET_SETUP_SECRET: undefined,
      // keep ARA_SETUP_SECRET from env
    },
    async () => {
      const factory = await import("../src/lib/persistence/store-factory");
      factory.resetStoreFactory();

      const setupMod = await import("../src/services/dataset/secure-store");
      const oauthMod = await import("../src/services/gmail/oauth");
      const setup = await setupMod.readDatasetSetup();
      if (!setup) throw new Error("Postgres dataset setup missing/undecryptable.");
      const before = {
        gmailAddress: setup.gmailAddress,
        driveAccountEmail: setup.driveAccountEmail,
      };
      await setupMod.writeDatasetSetup({
        ...setup,
        gmailAddress: TARGET,
        driveAccountEmail: TARGET,
        updatedAt: new Date().toISOString(),
      });
      await oauthMod.clearGmailAuth();
      const after = await setupMod.readDatasetSetup();
      const auth = await oauthMod.readGmailAuth();
      console.log(
        JSON.stringify({
          store: "postgres-app_config",
          before,
          after: {
            gmailAddress: after?.gmailAddress ?? null,
            driveAccountEmail: after?.driveAccountEmail ?? null,
          },
          oauthCleared: auth == null,
        })
      );
    }
  );
}

async function main() {
  await loadEnvLocal();
  await updateLocalFileSetup();
  await updatePostgresSetup();
}

main().catch((e) => {
  console.error("STOP:", e instanceof Error ? e.message : e);
  process.exit(1);
});
