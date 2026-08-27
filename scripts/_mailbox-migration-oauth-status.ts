/**
 * Poll until OAuth connects as mis@ (read-only status).
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

async function main() {
  await loadEnvLocal();
  process.env.ARA_PERSISTENCE = "file";
  delete process.env.ARA_DATASET_SETUP_SECRET;
  delete process.env.ARA_SETUP_SECRET;

  const { resetStoreFactory } = await import(
    "../src/lib/persistence/store-factory"
  );
  resetStoreFactory();
  const { readGmailAuth } = await import("../src/services/gmail/oauth");
  const { readDatasetSetup } = await import(
    "../src/services/dataset/secure-store"
  );

  const auth = await readGmailAuth();
  const setup = await readDatasetSetup();
  console.log(
    JSON.stringify(
      {
        connected: auth?.email ?? null,
        expected: setup?.gmailAddress ?? null,
        match:
          Boolean(auth?.email) &&
          auth!.email.toLowerCase() ===
            (setup?.gmailAddress ?? "").toLowerCase(),
        targetOk: auth?.email?.toLowerCase() === "mis@araresources.com",
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
