/**
 * Step 8 — Read-only mis@ inbox scan for Lateral Adhoc DS (no checkpoint changes).
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildLateralExcelDiscoveryQuery,
  discoverLateralExcelInMessage,
} from "../src/services/lateral-processing/lateral-excel-discovery";
import { DEFAULT_FILE_TYPES } from "../src/types/dataset-setup";

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
  const { getAuthorizedGmailClient } = await import(
    "../src/services/gmail/oauth"
  );

  const setup = await readDatasetSetup();
  const lateral = setup?.datasets?.Lateral;
  if (!lateral) throw new Error("Lateral dataset not configured.");

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const query = buildLateralExcelDiscoveryQuery({
    afterMs: thirtyDaysAgo,
    keywords: lateral.keywords ?? [],
    fileTypes: lateral.fileTypes?.length ? lateral.fileTypes : DEFAULT_FILE_TYPES,
  });

  const { gmail, auth } = await getAuthorizedGmailClient();
  const list = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 25,
  });

  const hits: Array<{
    subject: string;
    receivedAt: string;
    attachmentFilename: string;
    matchedKeyword: string | null;
  }> = [];

  for (const ref of list.data.messages ?? []) {
    if (!ref.id) continue;
    const full = await gmail.users.messages.get({
      userId: "me",
      id: ref.id,
      format: "full",
    });
    const discovered = discoverLateralExcelInMessage(full.data, {
      keywords: lateral.keywords ?? [],
      fileTypes: lateral.fileTypes?.length ? lateral.fileTypes : DEFAULT_FILE_TYPES,
    });
    if (!discovered) continue;
    const sel = discovered.selection.selected;
    hits.push({
      subject: discovered.subject,
      receivedAt: discovered.receivedAt,
      attachmentFilename: sel.attachmentName,
      matchedKeyword: sel.matchedKeyword?.keyword ?? null,
    });
  }

  console.log(
    JSON.stringify(
      {
        mailbox: auth.email,
        query,
        messageCount: list.data.messages?.length ?? 0,
        lateralExcelHits: hits.length,
        hits: hits.slice(0, 10),
        readOnly: true,
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
