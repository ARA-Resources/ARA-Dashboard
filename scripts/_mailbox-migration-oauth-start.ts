/**
 * OAuth start for mis@ using local file persistence (dev encryption key).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

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

async function main() {
  await loadEnvLocal();
  process.env.ARA_PERSISTENCE = "file";
  delete process.env.ARA_DATASET_SETUP_SECRET;
  delete process.env.ARA_SETUP_SECRET;

  const { resetStoreFactory } = await import(
    "../src/lib/persistence/store-factory"
  );
  resetStoreFactory();

  const { readDatasetSetup } = await import(
    "../src/services/dataset/secure-store"
  );
  const {
    readGmailAuth,
    buildGmailAuthUrl,
    saveOAuthState,
    isGmailOAuthConfigured,
  } = await import("../src/services/gmail/oauth");

  const setup = await readDatasetSetup();
  const auth = await readGmailAuth();
  const expected = (setup?.gmailAddress || "mis@araresources.com").toLowerCase();

  console.log(
    JSON.stringify(
      {
        persistence: process.env.ARA_PERSISTENCE,
        setupGmailAddress: setup?.gmailAddress ?? null,
        oauthConnected: auth?.email ?? null,
        expectedEmailForOAuth: expected,
        oauthConfigured: isGmailOAuthConfigured(),
      },
      null,
      2
    )
  );

  const state = randomBytes(24).toString("hex");
  await saveOAuthState(state, expected);
  const url = buildGmailAuthUrl({ loginHint: expected, state });
  console.log("\nOAUTH_START_URL=");
  console.log(url);
}

main().catch((e) => {
  console.error("STOP:", e instanceof Error ? e.message : e);
  process.exit(1);
});
