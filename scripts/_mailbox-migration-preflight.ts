/**
 * Read-only preflight for mailbox migration (no secrets printed).
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
  // Local encrypted files use the development key (verified in prior audit).
  delete process.env.ARA_DATASET_SETUP_SECRET;
  delete process.env.ARA_SETUP_SECRET;
  process.env.ARA_PERSISTENCE = "file";

  const { readGmailAuth } = await import("../src/services/gmail/oauth");
  const { readDatasetSetup } = await import("../src/services/dataset/secure-store");
  const { getGmailAccount } = await import("../src/lib/config/runtime");
  const { readLateralGmailCheckpoint } = await import(
    "../src/services/lateral-processing/lateral-gmail-checkpoint-store"
  );

  const auth = await readGmailAuth();
  const setup = await readDatasetSetup();
  const cp = await readLateralGmailCheckpoint();

  console.log(
    JSON.stringify(
      {
        oauthConnectedEmail: auth?.email ?? null,
        oauthExpectedEmail: auth?.expectedEmail ?? null,
        setupGmailAddress: setup?.gmailAddress ?? null,
        setupDriveAccountEmail: setup?.driveAccountEmail ?? null,
        envGmailAccount: process.env.GMAIL_ACCOUNT ?? null,
        envAraGmailAddress: process.env.ARA_GMAIL_ADDRESS ?? null,
        getGmailAccount: getGmailAccount() || null,
        checkpointHasMessageId: Boolean(cp.messageId),
        checkpointReceivedAt: cp.receivedAt,
        checkpointAttachmentFilename: cp.attachmentFilename,
        lateralKeywords:
          setup?.datasets?.Lateral?.keywords
            ?.filter((k) => k.enabled !== false)
            .map((k) => k.value) ?? [],
        driveFolders: {
          Lateral: setup?.datasets?.Lateral?.driveFolder ?? null,
        },
        note:
          "Cannot programmatically verify mis@ inbox/Drive without OAuth as mis@. Manual verification required before/during reconnect.",
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
