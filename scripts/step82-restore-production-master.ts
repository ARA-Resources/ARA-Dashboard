/**
 * STEP 8.2 — Restore production Master from the Step 8 backup.
 * Does NOT run Run All, Gmail sync, or checkpoint advance.
 *
 * Run: npx tsx scripts/step82-restore-production-master.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import { readLateralGmailCheckpoint } from "../src/services/lateral-processing/lateral-gmail-checkpoint-store";

const execFileAsync = promisify(execFile);

const BACKUP_DIR =
  "D:\\ARA Resources\\Dashboard New\\backups\\lateral-step8\\2026-08-17T10-37-19-792Z";
const BACKUP_NAME =
  "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm";
const BACKUP_PATH = path.join(BACKUP_DIR, BACKUP_NAME);
const EXPECTED_FILE_ID = "1ztfWeVhDyzYOHlvA8ujzvtSapRDvvPw9";
const EXPECTED_SHA256 =
  "c38c3da77348e11b18cdfe5d6eb420b30e65e1d298672b090e01dfed1d51b387";
const EXPECTED_MD5 = "12f96309a18bea6cff851f96beb58236";
const XLSM_MIME =
  "application/vnd.ms-excel.sheet.macroEnabled.12";

function hashFile(
  filePath: string,
  algo: "sha256" | "md5"
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algo);
    const stream = createReadStream(filePath);
    stream.on("data", (d) => hash.update(d));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function inspectXlsm(filePath: string) {
  const script = `
import json, sys, zipfile
from xml.etree import ElementTree as ET
from openpyxl import load_workbook

path = sys.argv[1]
out = {"ok": True}
with zipfile.ZipFile(path) as z:
    names = z.namelist()
    out["vba"] = any(n.lower().endswith("vbaproject.bin") for n in names)
    pivots = [n for n in names if n.lower().startswith("xl/pivottables/") and n.endswith(".xml") and "/_rels/" not in n]
    out["pivotXmlCount"] = len(pivots)
    names_attr = []
    for n in pivots:
        root = ET.fromstring(z.read(n))
        names_attr.append(root.attrib.get("name"))
    out["pivotNames"] = names_attr
    out["xlsm"] = path.lower().endswith(".xlsm")

wb = load_workbook(path, read_only=True, data_only=True)
out["sheets"] = wb.sheetnames
required = ["Master Sheet", "New Sheet", "Posted Sheet", "P-Roles"]
out["missingSheets"] = [s for s in required if s not in wb.sheetnames]
if "Master Sheet" in wb.sheetnames:
    ms = wb["Master Sheet"]
    headers = [str(c or "").strip() for c in next(ms.iter_rows(min_row=1, max_row=1, max_col=13, values_only=True))]
    out["headers"] = headers
    out["colK"] = headers[10] if len(headers) > 10 else ""
    out["colM"] = headers[12] if len(headers) > 12 else ""
wb.close()
print(json.dumps(out))
`.trim();
  const scriptPath = path.join(os.tmpdir(), `step82-inspect-${Date.now()}.py`);
  await fs.writeFile(scriptPath, script, "utf8");
  try {
    const { stdout } = await execFileAsync("python", [scriptPath, filePath], {
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse((stdout || "").trim() || "{}") as {
      ok?: boolean;
      vba?: boolean;
      xlsm?: boolean;
      sheets?: string[];
      missingSheets?: string[];
      pivotXmlCount?: number;
      pivotNames?: string[];
      headers?: string[];
      colK?: string;
      colM?: string;
    };
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

async function main() {
  console.log("=== STEP 8.2 — Restore production Master (no Run All) ===\n");

  if (!existsSync(BACKUP_PATH)) {
    console.error(`STOP: backup missing: ${BACKUP_PATH}`);
    process.exit(1);
  }

  const backupSha = await hashFile(BACKUP_PATH, "sha256");
  const backupMd5 = await hashFile(BACKUP_PATH, "md5");
  console.log("Backup SHA256:", backupSha);
  console.log("Backup MD5:   ", backupMd5);

  if (backupSha !== EXPECTED_SHA256) {
    console.error("STOP: backup SHA256 does not match expected. Restore aborted.");
    process.exit(1);
  }
  if (backupMd5 !== EXPECTED_MD5) {
    console.error("STOP: backup MD5 does not match expected. Restore aborted.");
    process.exit(1);
  }

  const backupInspect = await inspectXlsm(BACKUP_PATH);
  const backupOk =
    backupInspect.xlsm &&
    backupInspect.vba &&
    (backupInspect.missingSheets?.length ?? 1) === 0 &&
    (backupInspect.pivotXmlCount ?? 0) === 1;
  if (!backupOk) {
    console.error("STOP: backup integrity failed.", backupInspect);
    process.exit(1);
  }
  console.log("Backup integrity: XLSM + VBA + required sheets + 1 pivot");
  console.log("  sheets:", backupInspect.sheets?.join(", "));
  console.log("  pivot COM/OOXML name:", backupInspect.pivotNames?.join(", "));
  console.log("  K:", backupInspect.colK, " M:", backupInspect.colM);

  const { drive } = await getAuthorizedGmailClient();
  const before = await drive.files.get({
    fileId: EXPECTED_FILE_ID,
    fields: "id,name,size,modifiedTime,md5Checksum,mimeType,trashed",
    supportsAllDrives: true,
  });
  if (before.data.trashed) {
    console.error("STOP: production Master is trashed. Restore aborted.");
    process.exit(1);
  }
  console.log("\nCurrent production (before restore):");
  console.log(JSON.stringify(before.data, null, 2));

  const checkpointBefore = await readLateralGmailCheckpoint();

  console.log("\nRestoring backup content into existing Drive file…");
  await drive.files.update({
    fileId: EXPECTED_FILE_ID,
    requestBody: {
      name: BACKUP_NAME,
      mimeType: XLSM_MIME,
    },
    media: {
      mimeType: XLSM_MIME,
      body: createReadStream(BACKUP_PATH),
    },
    fields: "id,name,size,modifiedTime,md5Checksum,mimeType",
    supportsAllDrives: true,
  });

  const after = await drive.files.get({
    fileId: EXPECTED_FILE_ID,
    fields: "id,name,size,modifiedTime,md5Checksum,mimeType",
    supportsAllDrives: true,
  });
  console.log("\nProduction after restore:");
  console.log(JSON.stringify(after.data, null, 2));

  if (after.data.id !== EXPECTED_FILE_ID) {
    console.error("STOP: Drive file ID changed.");
    process.exit(1);
  }
  if ((after.data.name || "") !== BACKUP_NAME) {
    console.error(`STOP: filename changed to ${after.data.name}`);
    process.exit(1);
  }

  const tmpPath = path.join(os.tmpdir(), `step82-restored-${Date.now()}.xlsm`);
  const media = await drive.files.get(
    { fileId: EXPECTED_FILE_ID, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(tmpPath, Buffer.from(media.data as ArrayBuffer));
  const restoredSha = await hashFile(tmpPath, "sha256");
  const restoredMd5 = await hashFile(tmpPath, "md5");
  const restoredInspect = await inspectXlsm(tmpPath);
  await fs.unlink(tmpPath).catch(() => undefined);

  console.log("\nRestored content SHA256:", restoredSha);
  console.log("Restored content MD5:   ", restoredMd5);

  if (restoredSha !== EXPECTED_SHA256) {
    console.error("STOP: restored SHA256 does not match backup.");
    process.exit(1);
  }

  const checkpointAfter = await readLateralGmailCheckpoint();
  const checkpointOk =
    checkpointAfter.messageId === "19ffa890d265dde2" &&
    checkpointBefore.messageId === checkpointAfter.messageId &&
    checkpointAfter.attachmentFilename?.includes("13th Aug");

  const pipelineSrc = await fs.readFile(
    path.join(process.cwd(), "src/services/lateral-processing/pipeline.ts"),
    "utf8"
  );
  const commitFalse = pipelineSrc.includes("commitToProduction: false");

  const report = {
    backupVerified: true,
    backupSha256: backupSha,
    previousProduction: {
      id: before.data.id,
      name: before.data.name,
      size: before.data.size,
      modifiedTime: before.data.modifiedTime,
      md5: before.data.md5Checksum ?? null,
    },
    restoredProduction: {
      id: after.data.id,
      name: after.data.name,
      size: after.data.size,
      modifiedTime: after.data.modifiedTime,
      driveMd5: after.data.md5Checksum ?? null,
      contentSha256: restoredSha,
      contentMd5: restoredMd5,
    },
    integrity: restoredInspect,
    gmailCheckpoint: {
      messageId: checkpointAfter.messageId,
      attachmentFilename: checkpointAfter.attachmentFilename,
      receivedAt: checkpointAfter.receivedAt,
      unchanged: checkpointOk,
    },
    commitToProductionFalse: commitFalse,
    source17AugPending: checkpointOk,
  };

  await fs.writeFile(
    path.join(BACKUP_DIR, "restore-8.2.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );

  console.log("\n========== RESTORE REPORT ==========\n");
  console.log(JSON.stringify(report, null, 2));

  const integrityOk =
    restoredInspect.xlsm &&
    restoredInspect.vba &&
    (restoredInspect.missingSheets?.length ?? 1) === 0 &&
    (restoredInspect.pivotXmlCount ?? 0) >= 1 &&
    /job status/i.test(restoredInspect.colK || "") &&
    /posted/i.test(restoredInspect.colM || "") &&
    checkpointOk &&
    commitFalse;

  if (!integrityOk) {
    console.error("\nRestore completed but a verification check failed.");
    process.exit(1);
  }
  console.log("\nProduction Master restored. No Run All. No Gmail fetch.");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
