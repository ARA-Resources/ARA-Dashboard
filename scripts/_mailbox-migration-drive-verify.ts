/**
 * Step 12 — Read-only Drive access check for mis@ OAuth account.
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

  const { readDatasetSetup } = await import(
    "../src/services/dataset/secure-store"
  );
  const { getAuthorizedGmailClient } = await import(
    "../src/services/gmail/oauth"
  );

  const setup = await readDatasetSetup();
  const { drive, auth } = await getAuthorizedGmailClient();

  const lateralFolderId =
    setup?.datasets?.Lateral?.driveFolder?.folderId ??
    "1GY40OEKXWlRq4vkdtzXMkjs4Chn5laAP";
  const masterFileId =
    process.env.ARA_LATERAL_MASTER_DRIVE_FILE_ID?.trim() ||
    "1ztfWeVhDyzYOHlvA8ujzvtSapRDvvPw9";

  const checks: Record<string, unknown> = { mailbox: auth.email };

  try {
    const master = await drive.files.get({
      fileId: masterFileId,
      fields: "id,name,mimeType,trashed",
      supportsAllDrives: true,
    });
    checks.masterWorkbook = {
      ok: !master.data.trashed,
      id: master.data.id,
      name: master.data.name,
    };
  } catch (e) {
    checks.masterWorkbook = {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  try {
    const folder = await drive.files.get({
      fileId: lateralFolderId,
      fields: "id,name,mimeType,trashed",
      supportsAllDrives: true,
    });
    checks.lateralFolder = {
      ok: !folder.data.trashed,
      id: folder.data.id,
      name: folder.data.name,
    };
  } catch (e) {
    checks.lateralFolder = {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  try {
    const listed = await drive.files.list({
      q: `'${lateralFolderId}' in parents and trashed=false`,
      pageSize: 5,
      fields: "files(id,name,modifiedTime)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    checks.lateralFolderSampleFiles = (listed.data.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      modifiedTime: f.modifiedTime,
    }));
  } catch (e) {
    checks.lateralFolderSampleFiles = {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  console.log(JSON.stringify(checks, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
