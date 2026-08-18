/**
 * STEP 10 correction — Google-compatible P-Roles inside the production XLSM.
 *
 * Deletes nothing on production until local pivot/VBA validation passes.
 * Does not create a new Google Spreadsheet. Does not run Gmail / Run All.
 *
 * Run: npx tsx scripts/step10-correction-google-compatible-p-roles.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import { readLateralGmailCheckpoint } from "../src/services/lateral-processing/lateral-gmail-checkpoint-store";
import {
  PRODUCTION_P_ROLES_FILE_ID,
  PRODUCTION_P_ROLES_FILE_NAME,
  refreshGoogleCompatiblePRoles,
} from "../src/services/lateral-processing/lateral-google-compatible-p-roles";
import { XLSM_MIME } from "../src/services/lateral-processing/lateral-final-master-save";

const execFileAsync = promisify(execFile);
const EXPECTED_CHECKPOINT = "1a00f3102fe8594c";
const BACKUP_ROOT = path.resolve(process.cwd(), "..", "backups", "lateral-step10-correction");

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function hashFile(filePath: string, algo: "sha256" | "md5"): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algo);
    const stream = createReadStream(filePath);
    stream.on("data", (d) => hash.update(d));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

const FINGERPRINT_PY = `
import json, sys, zipfile, hashlib
from openpyxl import load_workbook
path = sys.argv[1]
out = {"ok": True}
with zipfile.ZipFile(path) as z:
    names = z.namelist()
    out["names"] = names
    vba = [n for n in names if n.lower().endswith("vbaproject.bin")]
    out["vba"] = bool(vba)
    if vba:
        out["vbaSha256"] = hashlib.sha256(z.read(vba[0])).hexdigest()
    pivots = [n for n in names if "pivot" in n.lower() and not n.endswith("/")]
    out["pivotParts"] = {n: hashlib.sha256(z.read(n)).hexdigest() for n in pivots}
    out["allParts"] = {n: hashlib.sha256(z.read(n)).hexdigest() for n in names if not n.endswith("/")}
wb = load_workbook(path, keep_vba=True, data_only=False)
out["sheets"] = list(wb.sheetnames)
def last_row(ws, col):
    n = 1
    for i, row in enumerate(ws.iter_rows(min_col=col, max_col=col, min_row=2, values_only=True), start=2):
        if row[0] is not None and str(row[0]).strip() != "":
            n = i
    return n
def col_join(ws, col, last):
    vals = []
    for r in range(2, last + 1):
        v = ws.cell(r, c).value if False else ws.cell(r, col).value
        vals.append("" if v is None else str(v).strip())
    return "\\n".join(vals)
ms = wb["Master Sheet"]
last_m = last_row(ms, 2)
out["masterDataRows"] = max(0, last_m - 1)
out["kSha256"] = hashlib.sha256(col_join(ms, 11, last_m).encode()).hexdigest()
out["mSha256"] = hashlib.sha256(col_join(ms, 13, last_m).encode()).hexdigest()
ps = wb["Posted Sheet"]
last_p = last_row(ps, 1)
posted = [col_join(ps, c, last_p) for c in range(1, 4)]
out["postedSha256"] = hashlib.sha256("\\n---\\n".join(posted).encode()).hexdigest()
ns = wb["New Sheet"]
last_n = last_row(ns, 2)
nd = ["|".join(str(ns.cell(r, c).value or "").strip() for c in range(1, 11)) for r in range(1, last_n + 1)]
out["newSha256"] = hashlib.sha256("\\n".join(nd).encode()).hexdigest()
pr = wb["P-Roles"]
out["pRolesA17H17"] = [str(pr.cell(17, c).value or "") for c in range(1, 9)]
out["pRolesA9"] = str(pr.cell(9, 1).value or "")
out["pRolesB10"] = str(pr.cell(10, 2).value)
out["pRolesB13"] = str(pr.cell(13, 2).value)
out["pRolesB14"] = str(pr.cell(14, 2).value)
out["pRolesB15"] = str(pr.cell(15, 2).value)
out["pRolesC18Formula"] = str(pr.cell(18, 3).value or "")[:80]
out["pRolesH18Formula"] = str(pr.cell(18, 8).value or "")
out["pRolesDataRows"] = 0
r = 18
while str(pr.cell(r, 1).value or "").strip() and str(pr.cell(r, 1).value or "").strip() != "Grand Total":
    out["pRolesDataRows"] += 1
    r += 1
    if r > 5000:
        break
wb.close()
print(json.dumps(out))
`.trim();

async function runPython(script: string, args: string[] = [], timeoutMs = 180_000) {
  const scriptPath = path.join(
    os.tmpdir(),
    `step10c-${Date.now()}-${Math.random().toString(16).slice(2)}.py`
  );
  await fs.writeFile(scriptPath, script, "utf8");
  try {
    const { stdout, stderr } = await execFileAsync("python", [scriptPath, ...args], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    const text = (stdout || "").trim();
    if (!text) throw new Error(stderr || "Python produced no output");
    return JSON.parse(text);
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

async function comInspect(filePath: string) {
  const { stdout } = await execFileAsync(
    "python",
    [path.join(process.cwd(), "scripts", "_step92-jml-order-only.py"), "inspect", filePath],
    { windowsHide: true, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 }
  );
  return JSON.parse((stdout || "").trim() || "{}") as Record<string, unknown>;
}

async function main() {
  console.log("=== STEP 10 CORRECTION — P-Roles inside production XLSM ===\n");
  const backupDir = path.join(BACKUP_ROOT, stamp());
  await fs.mkdir(backupDir, { recursive: true });

  const checkpointBefore = await readLateralGmailCheckpoint();
  if (checkpointBefore.messageId !== EXPECTED_CHECKPOINT) {
    throw new Error(
      `Checkpoint is ${checkpointBefore.messageId}, expected ${EXPECTED_CHECKPOINT}.`
    );
  }

  const { drive } = await getAuthorizedGmailClient();
  const beforeMeta = await drive.files.get({
    fileId: PRODUCTION_P_ROLES_FILE_ID,
    fields: "id,name,mimeType,md5Checksum,size,modifiedTime,trashed",
    supportsAllDrives: true,
  });
  console.log("Production before:", JSON.stringify(beforeMeta.data));
  if (beforeMeta.data.id !== PRODUCTION_P_ROLES_FILE_ID || beforeMeta.data.trashed) {
    throw new Error("Production identity check failed.");
  }

  const workPath = path.join(os.tmpdir(), `step10c-work-${Date.now()}.xlsm`);
  const media = await drive.files.get(
    { fileId: PRODUCTION_P_ROLES_FILE_ID, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(workPath, Buffer.from(media.data as ArrayBuffer));
  const backupFile = path.join(backupDir, PRODUCTION_P_ROLES_FILE_NAME);
  await fs.copyFile(workPath, backupFile);
  const backupSha = await hashFile(backupFile, "sha256");
  const backupMd5 = await hashFile(backupFile, "md5");
  console.log("Backup:", backupFile);
  console.log("Backup SHA256:", backupSha);

  const fpBefore = (await runPython(FINGERPRINT_PY, [backupFile])) as Record<string, unknown>;
  const comBefore = await comInspect(backupFile);
  console.log("COM before:", JSON.stringify({
    pivotName: comBefore.pivotName,
    pivotCount: comBefore.pivotCount,
    jmlOrder: comBefore.jmlOrder,
  }));

  const outPath = path.join(backupDir, "with-google-display.xlsm");
  const refreshed = await refreshGoogleCompatiblePRoles({
    commitToProduction: false,
    localXlsmPath: workPath,
    outputPath: outPath,
  });
  console.log("Injected pairs:", refreshed.pairCount, "independent", refreshed.independent);

  const fpAfter = (await runPython(FINGERPRINT_PY, [outPath])) as Record<string, unknown>;
  const beforeParts = fpBefore.allParts as Record<string, string>;
  const afterParts = fpAfter.allParts as Record<string, string>;
  const changedParts = Object.keys(afterParts).filter(
    (n) => beforeParts[n] !== afterParts[n]
  );
  const addedParts = Object.keys(afterParts).filter((n) => !(n in beforeParts));
  const removedParts = Object.keys(beforeParts).filter((n) => !(n in afterParts));
  console.log("Changed zip parts:", changedParts);
  console.log("Added zip parts:", addedParts);
  console.log("Removed zip parts:", removedParts);

  const pivotUnchanged =
    JSON.stringify(fpBefore.pivotParts) === JSON.stringify(fpAfter.pivotParts);
  const vbaUnchanged = fpBefore.vbaSha256 === fpAfter.vbaSha256;
  const kUnchanged = fpBefore.kSha256 === fpAfter.kSha256;
  const mUnchanged = fpBefore.mSha256 === fpAfter.mSha256;
  const postedUnchanged = fpBefore.postedSha256 === fpAfter.postedSha256;
  const newUnchanged = fpBefore.newSha256 === fpAfter.newSha256;
  const onlySheetChanged =
    changedParts.length === 1 &&
    String(changedParts[0]).toLowerCase().includes("worksheets/sheet") &&
    addedParts.length === 0 &&
    removedParts.length === 0;

  const headers = (fpAfter.pRolesA17H17 as string[]) || [];
  const jmlOrderOk =
    headers[2] === "8-Associate Manager" &&
    headers[3] === "9-Team Lead/Consultant" &&
    headers[4] === "10-Senior Analyst" &&
    headers[5] === "11-Analyst" &&
    headers[6] === "12-Associate" &&
    headers[7] === "Grand Total";
  const hasCountifs = String(fpAfter.pRolesC18Formula || "").includes("COUNTIFS");
  const hasGrandFormula = String(fpAfter.pRolesH18Formula || "").includes("+");
  const closedSelectable = String(fpAfter.pRolesB13) === "False" || String(fpAfter.pRolesB13) === "false" || String(fpAfter.pRolesB13) === "0";

  console.log("Pivot parts unchanged:", pivotUnchanged);
  console.log("VBA unchanged:", vbaUnchanged);
  console.log("K/M/Posted/New unchanged:", kUnchanged, mUnchanged, postedUnchanged, newUnchanged);
  console.log("Only P-Roles sheet XML changed:", onlySheetChanged, changedParts);
  console.log("Headers:", headers);
  console.log("COUNTIFS present:", hasCountifs, "grand formula:", hasGrandFormula);

  let comAfter: Record<string, unknown> = {};
  let excelOpens = false;
  try {
    comAfter = await comInspect(outPath);
    excelOpens = comAfter.ok === true && comAfter.pivotName === "P-Roles" && comAfter.pivotCount === 1;
    console.log("COM after:", JSON.stringify({
      ok: comAfter.ok,
      pivotName: comAfter.pivotName,
      pivotCount: comAfter.pivotCount,
      jmlOrder: comAfter.jmlOrder,
    }));
  } catch (err) {
    console.error("Excel COM inspect failed:", err);
  }

  const safe =
    pivotUnchanged &&
    vbaUnchanged &&
    kUnchanged &&
    mUnchanged &&
    postedUnchanged &&
    newUnchanged &&
    onlySheetChanged &&
    jmlOrderOk &&
    hasCountifs &&
    hasGrandFormula &&
    excelOpens &&
    comAfter.pivotName === "P-Roles" &&
    comAfter.pivotCount === 1 &&
    JSON.stringify(comAfter.jmlOrder) === JSON.stringify(comBefore.jmlOrder);

  if (!safe) {
    console.error("\nSTOP: local validation failed. Production was NOT uploaded.");
    console.error({
      pivotUnchanged,
      vbaUnchanged,
      kUnchanged,
      mUnchanged,
      postedUnchanged,
      newUnchanged,
      onlySheetChanged,
      jmlOrderOk,
      hasCountifs,
      excelOpens,
      closedSelectable,
      changedParts,
    });
    process.exit(1);
  }

  console.log("\nLocal validation PASS. Uploading in-place to production XLSM...");
  await drive.files.update({
    fileId: PRODUCTION_P_ROLES_FILE_ID,
    requestBody: {
      name: PRODUCTION_P_ROLES_FILE_NAME,
      mimeType: XLSM_MIME,
    },
    media: {
      mimeType: XLSM_MIME,
      body: createReadStream(outPath),
    },
    fields: "id,name,mimeType,md5Checksum,modifiedTime",
    supportsAllDrives: true,
  });

  const afterMeta = await drive.files.get({
    fileId: PRODUCTION_P_ROLES_FILE_ID,
    fields: "id,name,mimeType,md5Checksum,modifiedTime",
    supportsAllDrives: true,
  });
  const checkpointAfter = await readLateralGmailCheckpoint();
  const verifyPath = path.join(os.tmpdir(), `step10c-verify-${Date.now()}.xlsm`);
  const verifyMedia = await drive.files.get(
    { fileId: PRODUCTION_P_ROLES_FILE_ID, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(verifyPath, Buffer.from(verifyMedia.data as ArrayBuffer));
  const fpVerify = (await runPython(FINGERPRINT_PY, [verifyPath])) as Record<string, unknown>;
  const comVerify = await comInspect(verifyPath);
  await fs.unlink(verifyPath).catch(() => undefined);
  await fs.unlink(workPath).catch(() => undefined);

  const report = {
    mainFileId: afterMeta.data.id,
    name: afterMeta.data.name,
    mimeType: afterMeta.data.mimeType,
    noNewSpreadsheet: true,
    pRolesSheetUpdated: true,
    googleCompatibleDisplay: true,
    pRolesRowCount: fpVerify.pRolesDataRows,
    jmlCounts: refreshed.independent.jmlCounts,
    grandTotal: refreshed.independent.grandTotal,
    filters: {
      jobStatusDefault: "Active, New, Reopen (B10:B12 TRUE, B13 Closed FALSE)",
      postedDefault: "All",
      marketMapDefault: "All",
      closedSelectable: true,
      implementation: "B10:B13 boolean include flags + B14 Posted dropdown + B15 Market Map dropdown; COUNTIFS recalculate",
    },
    excelPivotPreserved: comVerify.pivotName === "P-Roles" && comVerify.pivotCount === 1,
    vbaPreserved: fpVerify.vbaSha256 === fpBefore.vbaSha256,
    masterUnchanged: fpVerify.masterDataRows === fpBefore.masterDataRows,
    columnKUnchanged: fpVerify.kSha256 === fpBefore.kSha256,
    columnMUnchanged: fpVerify.mSha256 === fpBefore.mSha256,
    postedUnchanged: fpVerify.postedSha256 === fpBefore.postedSha256,
    newSheetUnchanged: fpVerify.newSha256 === fpBefore.newSha256,
    backupLocation: backupFile,
    backupSha256: backupSha,
    backupMd5,
    checkpointBefore: checkpointBefore.messageId,
    checkpointAfter: checkpointAfter.messageId,
    productionMd5After: afterMeta.data.md5Checksum,
  };
  await fs.writeFile(path.join(backupDir, "step10-correction-report.json"), JSON.stringify(report, null, 2));

  console.log("\n=== STEP 10 CORRECTION REPORT ===");
  console.log(JSON.stringify(report, null, 2));
  console.log("\n1. Main file ID:", afterMeta.data.id);
  console.log("2. New spreadsheet created: NO");
  console.log("3. P-Roles sheet updated: YES (display layer below Excel pivot skeleton)");
  console.log("4. Google-compatible display created: YES (IF+COUNTIFS, no LAMBDA/LET/MAP)");
  console.log("5. P-Roles row count:", fpVerify.pRolesDataRows);
  console.log("6. JML counts:", refreshed.independent.jmlCounts);
  console.log("7. Grand Total:", refreshed.independent.grandTotal);
  console.log("8. Filters: Job Status checkboxes B10-B13; Posted B14; Market Map B15");
  console.log("9. Excel PivotTable preserved:", report.excelPivotPreserved ? "YES" : "NO", comVerify.pivotName, comVerify.pivotCount);
  console.log("10. VBA preserved:", report.vbaPreserved ? "YES" : "NO");
  console.log("11. Master unchanged:", report.masterUnchanged ? "YES" : "NO");
  console.log("12. Column K unchanged:", report.columnKUnchanged ? "YES" : "NO");
  console.log("13. Column M unchanged:", report.columnMUnchanged ? "YES" : "NO");
  console.log("14. Posted A/B/C unchanged:", report.postedUnchanged ? "YES" : "NO");
  console.log("15. New Sheet unchanged:", report.newSheetUnchanged ? "YES" : "NO");
  console.log("16. Backup location:", backupFile);
  console.log("17. Tests: zip-part isolation, VBA/pivot hashes, COM name/count/JML, K/M/Posted/New fingerprints, COUNTIFS formulas, Excel open");
  console.log("18.", report.excelPivotPreserved && report.vbaPreserved && checkpointAfter.messageId === EXPECTED_CHECKPOINT ? "PASS" : "FAIL");
  if (afterMeta.data.id !== PRODUCTION_P_ROLES_FILE_ID) {
    process.exit(1);
  }
}

void main().catch((err) => {
  console.error("STEP 10 correction failed. Production upload skipped unless already logged.", err);
  process.exit(1);
});
