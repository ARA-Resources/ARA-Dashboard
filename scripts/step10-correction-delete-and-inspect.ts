/**
 * STEP 10 correction — delete the separate Google Spreadsheet and inspect
 * production P-Roles. Read-only on the XLSM. No upload.
 *
 * Run: npx tsx scripts/step10-correction-delete-and-inspect.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import { readLateralGmailCheckpoint } from "../src/services/lateral-processing/lateral-gmail-checkpoint-store";

const execFileAsync = promisify(execFile);
const PRODUCTION_ID = "1ztfWeVhDyzYOHlvA8ujzvtSapRDvvPw9";
const SEPARATE_ID = "1hMtun19a-v4X_UpBr3yXyY26gdspczaBA0m8XK_lw7s";
const STATE_PATH = path.join(process.cwd(), ".data", "lateral-native-p-roles-google-sheet.json");

async function main() {
  const checkpoint = await readLateralGmailCheckpoint();
  console.log("Checkpoint:", checkpoint.messageId, checkpoint.processingResult);

  const { drive } = await getAuthorizedGmailClient();

  const prodBefore = await drive.files.get({
    fileId: PRODUCTION_ID,
    fields: "id,name,mimeType,md5Checksum,size,modifiedTime,trashed",
    supportsAllDrives: true,
  });
  console.log("Production before delete:", JSON.stringify(prodBefore.data));

  try {
    const separate = await drive.files.get({
      fileId: SEPARATE_ID,
      fields: "id,name,mimeType,trashed",
      supportsAllDrives: true,
    });
    console.log("Separate file:", JSON.stringify(separate.data));
    if (separate.data.mimeType !== "application/vnd.google-apps.spreadsheet") {
      throw new Error("Refusing to delete: target is not a Google Spreadsheet.");
    }
    if (separate.data.id === PRODUCTION_ID) {
      throw new Error("Refusing to delete production.");
    }
    await drive.files.delete({ fileId: SEPARATE_ID, supportsAllDrives: true });
    console.log("Deleted separate spreadsheet", SEPARATE_ID);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/File not found|404|notFound/i.test(msg)) {
      console.log("Separate spreadsheet already gone.");
    } else {
      throw err;
    }
  }

  await fs.unlink(STATE_PATH).catch(() => undefined);
  console.log("Removed native P-Roles state file (if present).");

  const dest = path.join(os.tmpdir(), `step10c-inspect-${Date.now()}.xlsm`);
  const media = await drive.files.get(
    { fileId: PRODUCTION_ID, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(dest, Buffer.from(media.data as ArrayBuffer));
  console.log("Downloaded production copy for inspect:", dest);

  const inspectPy = path.join(process.cwd(), "scripts", "_inspect-p-roles-layout.py");
  const { stdout } = await execFileAsync("python", [inspectPy, dest], {
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const layout = JSON.parse(stdout);
  console.log("\n=== LAYOUT ===");
  console.log(JSON.stringify({
    sheets: layout.sheets,
    vba: layout.vba,
    vbaSha256: layout.vbaSha256,
    pivotXmlFiles: layout.pivotXmlFiles,
    pivotDefinitions: layout.pivotDefinitions,
    pRoles: layout.pRoles,
    pRolesUsedCount: layout.pRolesUsedCount,
    masterHeaders: layout.masterHeaders,
    masterDataRows: layout.masterDataRows,
  }, null, 2));
  console.log("\n=== P-ROLES GRID ===");
  console.log(JSON.stringify(layout.pRolesGrid24x11, null, 2));
  console.log("\n=== USED CELLS ===");
  console.log(JSON.stringify(layout.pRolesUsedCells, null, 2));
  console.log("\n=== PIVOT PART HASHES ===");
  console.log(JSON.stringify(layout.pivotParts, null, 2));
  console.log("\n=== SHEET RELS ===");
  console.log(JSON.stringify(layout.worksheetRels, null, 2));

  try {
    const comPy = path.join(process.cwd(), "scripts", "_step92-jml-order-only.py");
    const com = await execFileAsync("python", [comPy, "inspect", dest], {
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    console.log("\n=== COM INSPECT ===");
    console.log(com.stdout);
  } catch (err) {
    console.log("COM inspect failed:", err instanceof Error ? err.message : err);
  }

  const prodAfter = await drive.files.get({
    fileId: PRODUCTION_ID,
    fields: "id,md5Checksum,modifiedTime,mimeType",
    supportsAllDrives: true,
  });
  console.log("\nProduction after (must match before):", JSON.stringify(prodAfter.data));
  console.log(
    "Production untouched:",
    prodAfter.data.md5Checksum === prodBefore.data.md5Checksum
  );
  await fs.unlink(dest).catch(() => undefined);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
