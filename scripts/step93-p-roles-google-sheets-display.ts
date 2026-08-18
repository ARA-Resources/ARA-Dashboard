/**
 * STEP 9.3 — Google Sheets-compatible P-Roles display layer.
 *
 * Adds "P-Roles Display" with live Master Sheet formulas.
 * Does not modify the Excel PivotTable, Master, Posted, New Sheet, VBA, Gmail.
 *
 * Tests via a throwaway Google Sheets conversion BEFORE production upload.
 *
 * Run: npx tsx scripts/step93-p-roles-google-sheets-display.ts
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

const execFileAsync = promisify(execFile);

const EXPECTED_FILE_ID = "1ztfWeVhDyzYOHlvA8ujzvtSapRDvvPw9";
const EXPECTED_NAME =
  "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm";
const EXPECTED_CHECKPOINT = "1a00f3102fe8594c";
const XLSM_MIME =
  "application/vnd.ms-excel.sheet.macroEnabled.12";
const SHEETS_MIME = "application/vnd.google-apps.spreadsheet";
const DISPLAY_SHEET = "P-Roles Display";
const JML_CANONICAL = [
  "8-Associate Manager",
  "9-Team Lead/Consultant",
  "10-Senior Analyst",
  "11-Analyst",
  "12-Associate",
];
const BACKUP_ROOT = path.resolve(
  process.cwd(),
  "..",
  "backups",
  "lateral-step93"
);

type Stage =
  | "preflight"
  | "download"
  | "backup"
  | "inspect"
  | "add-display"
  | "verify-xlsm"
  | "test-google-sheets"
  | "upload"
  | "post-verify";

type Report = {
  ok: boolean;
  stage: Stage;
  failure?: string;
  uploadOccurred: boolean;
  diagnosis?: string;
  fileId: string;
  backupPath?: string;
  backupSha256?: string;
  backupMd5?: string;
  finalSha256?: string;
  checkpointBefore?: string | null;
  checkpointAfter?: string | null;
  fingerprintsBefore?: unknown;
  fingerprintsAfter?: unknown;
  pivotBefore?: unknown;
  pivotAfter?: unknown;
  googleTest?: unknown;
  vba?: unknown;
};

function stamp(): string {
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

async function runPython(script: string, args: string[] = [], timeoutMs = 180_000) {
  const scriptPath = path.join(
    os.tmpdir(),
    `step93-${Date.now()}-${Math.random().toString(16).slice(2)}.py`
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

const FINGERPRINT_PY = `
import json, sys, zipfile, hashlib
from openpyxl import load_workbook
path = sys.argv[1]
out = {"ok": True}
with zipfile.ZipFile(path) as z:
    names = z.namelist()
    vba = [n for n in names if n.lower().endswith("vbaproject.bin")]
    out["vba"] = bool(vba)
    if vba:
        out["vbaSha256"] = hashlib.sha256(z.read(vba[0])).hexdigest()
    pivots = [n for n in names if "pivot" in n.lower() and not n.endswith("/")]
    out["pivotParts"] = {n: hashlib.sha256(z.read(n)).hexdigest() for n in pivots}
    out["pivotXmlCount"] = len([n for n in pivots if n.lower().startswith("xl/pivottables/") and n.endswith(".xml") and "/_rels/" not in n])
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
        v = ws.cell(r, col).value
        vals.append("" if v is None else str(v).strip())
    return "\\n".join(vals)
ms = wb["Master Sheet"]
out["masterHeaders"] = [str(ms.cell(1, c).value or "").strip() for c in range(1, 14)]
last_m = last_row(ms, 2)
out["masterDataRows"] = max(0, last_m - 1)
out["kSha256"] = hashlib.sha256(col_join(ms, 11, last_m).encode()).hexdigest()
out["mSha256"] = hashlib.sha256(col_join(ms, 13, last_m).encode()).hexdigest()
out["jrSha256"] = hashlib.sha256(col_join(ms, 2, last_m).encode()).hexdigest()
ps = wb["Posted Sheet"]
last_p = last_row(ps, 1)
posted = [col_join(ps, c, last_p) for c in range(1, 4)]
out["postedSha256"] = hashlib.sha256("\\n---\\n".join(posted).encode()).hexdigest()
ns = wb["New Sheet"]
last_n = last_row(ns, 2)
nd = ["|".join(str(ns.cell(r, c).value or "").strip() for c in range(1, 11)) for r in range(1, last_n + 1)]
out["newSha256"] = hashlib.sha256("\\n".join(nd).encode()).hexdigest()
out["hasDisplaySheet"] = "P-Roles Display" in wb.sheetnames
wb.close()
print(json.dumps(out))
`.trim();

const RESTORE_VBA_PY = `
import json, sys, zipfile, hashlib, os
before, after = sys.argv[1], sys.argv[2]
def vba_name(p):
    with zipfile.ZipFile(p) as z:
        names = [n for n in z.namelist() if n.lower().endswith("vbaproject.bin")]
        return names[0] if names else None
bn, an = vba_name(before), vba_name(after)
if not bn or not an:
    print(json.dumps({"ok": False, "error": "vbaProject.bin missing"}))
    raise SystemExit(0)
with zipfile.ZipFile(before) as zb:
    original = zb.read(bn)
with zipfile.ZipFile(after) as za:
    current = za.read(an)
    changed = hashlib.sha256(original).hexdigest() != hashlib.sha256(current).hexdigest()
restored = False
if changed:
    tmp = after + ".vba.zip"
    with zipfile.ZipFile(after) as za, zipfile.ZipFile(tmp, "w") as zo:
        for info in za.infolist():
            data = original if info.filename.lower().endswith("vbaproject.bin") else za.read(info.filename)
            zo.writestr(info, data)
    os.replace(tmp, after)
    restored = True
print(json.dumps({"ok": True, "vbaChanged": changed, "vbaRestored": restored, "vbaPresent": True}))
`.trim();

async function writeReport(dir: string, report: Report) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "step93-report.json"), JSON.stringify(report, null, 2), "utf8");
}

async function fail(report: Report, backupDir: string): Promise<never> {
  report.ok = false;
  const cp = await readLateralGmailCheckpoint().catch(() => null);
  report.checkpointAfter = cp?.messageId ?? report.checkpointBefore ?? null;
  await writeReport(backupDir, report);
  console.error("\n=== STEP 9.3 FAILED ===");
  console.error("Stage:", report.stage);
  console.error("Failure:", report.failure);
  console.error("Production upload occurred:", report.uploadOccurred ? "YES" : "NO");
  process.exit(1);
}

async function downloadDriveFile(
  drive: Awaited<ReturnType<typeof getAuthorizedGmailClient>>["drive"],
  fileId: string,
  dest: string
) {
  const media = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(dest, Buffer.from(media.data as ArrayBuffer));
}

async function runComInspect(filePath: string) {
  const { stdout } = await execFileAsync(
    "python",
    [path.join(process.cwd(), "scripts", "_step92-jml-order-only.py"), "inspect", filePath],
    { windowsHide: true, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }
  );
  return JSON.parse((stdout || "").trim() || "{}") as Record<string, unknown>;
}

async function main() {
  console.log("=== STEP 9.3 — P-Roles Google Sheets display layer ===\n");
  const backupDir = path.join(BACKUP_ROOT, stamp());
  await fs.mkdir(backupDir, { recursive: true });
  const report: Report = {
    ok: false,
    stage: "preflight",
    uploadOccurred: false,
    fileId: EXPECTED_FILE_ID,
    backupPath: backupDir,
    diagnosis:
      "Google Sheets reads worksheet cells only. The Excel P-Roles PivotTable stores counts in PivotCache XML, not in cells, so Sheets shows the skeleton labels with blank values. Master Sheet data is present.",
  };

  const checkpointBefore = await readLateralGmailCheckpoint();
  report.checkpointBefore = checkpointBefore.messageId;
  if (checkpointBefore.messageId !== EXPECTED_CHECKPOINT) {
    report.failure = `Checkpoint is ${checkpointBefore.messageId}, expected ${EXPECTED_CHECKPOINT}.`;
    return fail(report, backupDir);
  }

  const { drive, sheets } = await getAuthorizedGmailClient();
  const beforeMeta = await drive.files.get({
    fileId: EXPECTED_FILE_ID,
    fields: "id,name,size,modifiedTime,md5Checksum,mimeType,trashed,parents",
    supportsAllDrives: true,
  });
  if (beforeMeta.data.trashed || beforeMeta.data.id !== EXPECTED_FILE_ID) {
    report.failure = "Production identity check failed.";
    return fail(report, backupDir);
  }
  console.log("Production:", JSON.stringify({
    id: beforeMeta.data.id,
    md5: beforeMeta.data.md5Checksum,
    size: beforeMeta.data.size,
  }));

  report.stage = "download";
  const workPath = path.join(os.tmpdir(), `step93-work-${Date.now()}.xlsm`);
  await downloadDriveFile(drive, EXPECTED_FILE_ID, workPath);

  report.stage = "backup";
  const backupFile = path.join(backupDir, EXPECTED_NAME);
  await fs.copyFile(workPath, backupFile);
  report.backupSha256 = await hashFile(backupFile, "sha256");
  report.backupMd5 = await hashFile(backupFile, "md5");
  console.log("Backup SHA256:", report.backupSha256);
  console.log("Backup MD5:", report.backupMd5);

  report.stage = "inspect";
  const fpBefore = (await runPython(FINGERPRINT_PY, [backupFile])) as Record<string, unknown>;
  const comBefore = await runComInspect(backupFile);
  report.fingerprintsBefore = fpBefore;
  report.pivotBefore = {
    name: comBefore.pivotName,
    count: comBefore.pivotCount,
    jml: comBefore.jmlOrder,
    source: comBefore.sourceData,
    values: comBefore.valueFields,
  };
  console.log("Master rows:", fpBefore.masterDataRows, "headers:", fpBefore.masterHeaders);
  console.log("Pivot:", comBefore.pivotName, "count", comBefore.pivotCount, "JML", comBefore.jmlOrder);
  if (!fpBefore.vba || fpBefore.pivotXmlCount !== 1 || comBefore.pivotName !== "P-Roles") {
    report.failure = "Precheck: VBA or Excel PivotTable not in expected state.";
    return fail(report, backupDir);
  }

  report.stage = "add-display";
  const { stdout, stderr } = await execFileAsync(
    "python",
    [path.join(process.cwd(), "scripts", "_step93-add-p-roles-display.py"), workPath],
    { windowsHide: true, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }
  );
  const added = JSON.parse((stdout || "").trim() || "{}") as {
    ok?: boolean;
    error?: string;
    sheets?: string[];
  };
  if (!added.ok) {
    report.failure = `Failed to add display sheet: ${added.error || stderr}`;
    return fail(report, backupDir);
  }
  console.log("Sheets after add:", added.sheets);

  const vbaRestore = (await runPython(RESTORE_VBA_PY, [backupFile, workPath])) as {
    ok?: boolean;
    vbaRestored?: boolean;
    vbaChanged?: boolean;
  };
  report.vba = vbaRestore;
  console.log("VBA restore:", vbaRestore);

  report.stage = "verify-xlsm";
  const fpAfter = (await runPython(FINGERPRINT_PY, [workPath])) as Record<string, unknown>;
  const comAfter = await runComInspect(workPath);
  report.fingerprintsAfter = fpAfter;
  report.pivotAfter = {
    name: comAfter.pivotName,
    count: comAfter.pivotCount,
    jml: comAfter.jmlOrder,
    source: comAfter.sourceData,
    values: comAfter.valueFields,
  };

  const xlsmChecks: string[] = [];
  if (fpAfter.kSha256 !== fpBefore.kSha256) xlsmChecks.push("Column K changed");
  if (fpAfter.mSha256 !== fpBefore.mSha256) xlsmChecks.push("Column M changed");
  if (fpAfter.jrSha256 !== fpBefore.jrSha256) xlsmChecks.push("JR ids changed");
  if (fpAfter.postedSha256 !== fpBefore.postedSha256) xlsmChecks.push("Posted A/B/C changed");
  if (fpAfter.newSha256 !== fpBefore.newSha256) xlsmChecks.push("New Sheet changed");
  if (fpAfter.vbaSha256 !== fpBefore.vbaSha256) xlsmChecks.push("VBA hash changed");
  if (JSON.stringify(fpAfter.pivotParts) !== JSON.stringify(fpBefore.pivotParts)) {
    xlsmChecks.push("Excel PivotTable zip parts changed");
  }
  if (fpAfter.pivotXmlCount !== 1) xlsmChecks.push("pivot count xml");
  if (comAfter.pivotName !== "P-Roles" || comAfter.pivotCount !== 1) {
    xlsmChecks.push("COM pivot identity changed");
  }
  if (JSON.stringify(comAfter.jmlOrder) !== JSON.stringify(comBefore.jmlOrder)) {
    xlsmChecks.push("JML order changed");
  }
  if (comAfter.sourceData !== comBefore.sourceData) xlsmChecks.push("pivot source changed");
  if (!fpAfter.hasDisplaySheet) xlsmChecks.push("P-Roles Display sheet missing");
  if (xlsmChecks.length) {
    report.failure = xlsmChecks.join(" | ");
    return fail(report, backupDir);
  }
  console.log("XLSM safety checks passed. Excel PivotTable unmodified.");

  report.stage = "test-google-sheets";
  console.log("Uploading throwaway conversion copy (not production)…");
  const { Readable } = await import("node:stream");
  const buf = await fs.readFile(workPath);
  const created = await drive.files.create({
    requestBody: {
      name: `STEP93 TEST P-Roles Display DELETE ME ${stamp()}`,
      mimeType: SHEETS_MIME,
    },
    media: { mimeType: XLSM_MIME, body: Readable.from(buf) },
    fields: "id,name,mimeType",
    supportsAllDrives: true,
  });
  const testId = created.data.id;
  if (!testId || created.data.mimeType !== SHEETS_MIME) {
    if (testId) await drive.files.delete({ fileId: testId, supportsAllDrives: true }).catch(() => undefined);
    report.failure =
      "Could not convert a test copy to Google Sheets. Refusing production upload. " +
      `Got mimeType=${created.data.mimeType}`;
    return fail(report, backupDir);
  }
  console.log("Test Google Sheet:", testId);

  await new Promise((r) => setTimeout(r, 8000));
  let gsValues: string[][] = [];
  let gsError: string | undefined;
  try {
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId: testId,
      range: `'${DISPLAY_SHEET}'!A15:H40`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    gsValues = (got.data.values as string[][]) || [];
  } catch (err) {
    gsError = err instanceof Error ? err.message : String(err);
  }

  const header = (gsValues[0] || []).map((c) => String(c || "").trim());
  const dataRows = gsValues.slice(1).filter((r) => (r[0] || "").toString().trim());
  const jmlOk = JML_CANONICAL.every((name) => header.includes(name));
  const numericCells = dataRows.flatMap((r) => r.slice(2, 8)).filter((v) => {
    const n = Number(String(v).replace(/,/g, ""));
    return Number.isFinite(n) && n > 0;
  });
  const gsPass =
    !gsError &&
    jmlOk &&
    header.includes("Grand Total") &&
    header.includes("Primary Skills") &&
    header.includes("Skill Categorization") &&
    dataRows.length > 0 &&
    numericCells.length > 0;

  report.googleTest = {
    spreadsheetId: testId,
    error: gsError,
    header,
    dataRowCount: dataRows.length,
    sample: dataRows.slice(0, 3),
    jmlOk,
    numericPositiveCount: numericCells.length,
    pass: gsPass,
  };
  console.log("Google Sheets test:", JSON.stringify(report.googleTest, null, 2));

  await drive.files.delete({ fileId: testId, supportsAllDrives: true }).catch(() => undefined);

  if (!gsPass) {
    report.failure =
      "Google Sheets conversion test did not show live P-Roles counts. " +
      "Production XLSM was NOT uploaded. " +
      (gsError || `header=${header.join(" | ")} rows=${dataRows.length} numeric=${numericCells.length}`);
    return fail(report, backupDir);
  }

  const checkpointMid = await readLateralGmailCheckpoint();
  if (checkpointMid.messageId !== EXPECTED_CHECKPOINT) {
    report.failure = "Checkpoint changed before production upload.";
    return fail(report, backupDir);
  }

  report.stage = "upload";
  console.log("Google Sheets test passed. Uploading XLSM to production file ID…");
  await drive.files.update({
    fileId: EXPECTED_FILE_ID,
    requestBody: { name: EXPECTED_NAME, mimeType: XLSM_MIME },
    media: { mimeType: XLSM_MIME, body: createReadStream(workPath) },
    fields: "id,name,mimeType,md5Checksum",
    supportsAllDrives: true,
  });
  report.uploadOccurred = true;

  report.stage = "post-verify";
  const verifyPath = path.join(os.tmpdir(), `step93-verify-${Date.now()}.xlsm`);
  await downloadDriveFile(drive, EXPECTED_FILE_ID, verifyPath);
  report.finalSha256 = await hashFile(verifyPath, "sha256");
  const fpVerify = (await runPython(FINGERPRINT_PY, [verifyPath])) as Record<string, unknown>;
  const comVerify = await runComInspect(verifyPath);
  if (
    fpVerify.kSha256 !== fpBefore.kSha256 ||
    fpVerify.mSha256 !== fpBefore.mSha256 ||
    fpVerify.postedSha256 !== fpBefore.postedSha256 ||
    fpVerify.vbaSha256 !== fpBefore.vbaSha256 ||
    JSON.stringify(fpVerify.pivotParts) !== JSON.stringify(fpBefore.pivotParts) ||
    comVerify.pivotName !== "P-Roles" ||
    comVerify.pivotCount !== 1 ||
    !fpVerify.hasDisplaySheet
  ) {
    report.failure = "Post-upload verification failed.";
    return fail(report, backupDir);
  }

  const checkpointAfter = await readLateralGmailCheckpoint();
  report.checkpointAfter = checkpointAfter.messageId;
  report.ok = true;
  await writeReport(backupDir, report);
  await fs.unlink(workPath).catch(() => undefined);
  await fs.unlink(verifyPath).catch(() => undefined);

  console.log("\n=== STEP 9.3 PASS ===");
  console.log("1. Why blank:", report.diagnosis);
  console.log("2. Excel PivotTable modified: NO");
  console.log("3. Google-compatible display layer: YES — sheet", DISPLAY_SHEET);
  console.log("4. Source: Master Sheet live formulas (not PivotCache)");
  console.log("5. JML order:", JML_CANONICAL.join(" → "));
  console.log("6. Row fields: Primary Skills → Skill Categorization");
  console.log("7. Value: Count of Job Requisition ID (COUNTIFS)");
  console.log("8. Filters: Job Status checkboxes, Posted dropdown, Market Map dropdown");
  console.log("9. Closed available: YES (default FALSE)");
  console.log("10. Master K:", fpBefore.kSha256, "===", fpVerify.kSha256);
  console.log("11. Master M:", fpBefore.mSha256, "===", fpVerify.mSha256);
  console.log("12. Posted A/B/C:", fpBefore.postedSha256, "===", fpVerify.postedSha256);
  console.log("13. VBA:", fpBefore.vbaSha256, "===", fpVerify.vbaSha256);
  console.log("14. Excel PivotTable:", comVerify.pivotName, "count", comVerify.pivotCount);
  console.log("15. Google Sheets test: PASS", `rows=${dataRows.length}`);
  console.log("16. Production upload: YES", EXPECTED_FILE_ID);
  console.log("17. Backup:", backupFile);
  console.log("18. PASS");
}

void main().catch((err) => {
  console.error("STEP 9.3 crashed:", err);
  process.exit(1);
});
