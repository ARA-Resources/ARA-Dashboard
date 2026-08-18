/**
 * Keep only the latest RECONCILE_BACKUP in the Lateral Drive folder; trash the rest.
 * Run: npx tsx scripts/prune-reconcile-backups.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import { readLateralDataProcessingSetup } from "../src/services/lateral-processing/setup-store";
import { resolveProcessingFolderId } from "../src/services/lateral-processing/setup-validation";

async function main() {
  const setup = await readLateralDataProcessingSetup();
  if (!setup) throw new Error("Lateral processing setup not found.");

  const folderId = resolveProcessingFolderId(setup.sourceFolder);
  if (!folderId) throw new Error("Source folder not configured.");

  const { drive } = await getAuthorizedGmailClient();
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
    pageSize: 200,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    corpora: "allDrives",
  });

  const backups = (res.data.files ?? []).filter((f) =>
    /_RECONCILE_BACKUP_/i.test(f.name ?? "")
  );

  if (backups.length === 0) {
    console.log("No RECONCILE_BACKUP files found in folder", folderId);
    return;
  }

  backups.sort((a, b) =>
    (b.modifiedTime || "").localeCompare(a.modifiedTime || "")
  );

  const keep = backups[0];
  const remove = backups.slice(1);

  console.log(`Found ${backups.length} reconcile backup(s) in folder ${folderId}`);
  console.log(`KEEP (latest): ${keep.name} (${keep.modifiedTime})`);

  if (remove.length === 0) {
    console.log("Nothing to remove — only one backup exists.");
    return;
  }

  for (const file of remove) {
    console.log(`TRASH: ${file.name} (${file.modifiedTime})`);
    await drive.files.update({
      fileId: file.id!,
      supportsAllDrives: true,
      requestBody: { trashed: true },
    });
  }

  console.log(`Done. Kept 1, trashed ${remove.length}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
