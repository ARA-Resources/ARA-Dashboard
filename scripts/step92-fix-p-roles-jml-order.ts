/**
 * STEP 9.2 — Surgical production fix: P-Roles JML column item order only.
 *
 * Does NOT: Gmail, Run All, New/Posted/Master data, Column K/M, pivot
 * recreate/refresh/source/filters, Home metrics, checkpoint.
 *
 * Run: npx tsx scripts/step92-fix-p-roles-jml-order.ts
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
  "lateral-step92"
);
const COM_SCRIPT = path.join(
  process.cwd(),
  "scripts",
  "_step92-jml-order-only.py"
);

type Stage =
  | "preflight"
  | "download"
  | "backup"
  | "inspect"
  | "apply"
  | "vba-gate"
  | "verify"
  | "upload"
  | "post-verify";

type Report = {
  ok: boolean;
  stage: Stage;
  failure?: string;
  productionModified: boolean;
  uploadOccurred: boolean;
  fileId: string;
  backupPath?: string;
  backupSha256?: string;
  backupMd5?: string;
  backupSize?: number;
  finalSha256?: string;
  checkpointBefore?: string | null;
  checkpointAfter?: string | null;
  oldJmlOrder?: string[];
  newJmlOrder?: string[];
  pivot?: unknown;
  fingerprintsBefore?: unknown;
  fingerprintsAfter?: unknown;
  zipDiff?: unknown;
  vba?: unknown;
  productionBefore?: Record<string, unknown>;
  productionAfter?: Record<string, unknown>;
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

async function runPython(
  script: string,
  args: string[] = [],
  timeoutMs = 180_000
): Promise<unknown> {
  const scriptPath = path.join(
    os.tmpdir(),
    `step92-${Date.now()}-${Math.random().toString(16).slice(2)}.py`
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

async function runCom(action: "inspect" | "apply", filePath: string) {
  const { stdout, stderr } = await execFileAsync(
    "python",
    [COM_SCRIPT, action, filePath],
    {
      windowsHide: true,
      timeout: action === "apply" ? 600_000 : 180_000,
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  const text = (stdout || "").trim();
  if (!text) throw new Error(stderr || "COM script produced no output");
  return JSON.parse(text) as Record<string, unknown>;
}

const FINGERPRINT_PY = `
import json, sys, zipfile, hashlib
from openpyxl import load_workbook

path = sys.argv[1]
out = {"ok": True}

with zipfile.ZipFile(path) as z:
    names = z.namelist()
    vba_names = [n for n in names if n.lower().endswith("vbaproject.bin")]
    out["vba"] = bool(vba_names)
    out["vbaNames"] = vba_names
    if vba_names:
        h = hashlib.sha256()
        h.update(z.read(vba_names[0]))
        out["vbaSha256"] = h.hexdigest()
        out["vbaSize"] = len(z.read(vba_names[0]))
    pivots = [n for n in names if n.lower().startswith("xl/pivottables/") and n.endswith(".xml") and "/_rels/" not in n]
    out["pivotXmlCount"] = len(pivots)
    parts = {}
    for n in names:
        if n.endswith("/"):
            continue
        parts[n] = hashlib.sha256(z.read(n)).hexdigest()
    out["zipPartCount"] = len(parts)
    out["zipParts"] = parts

wb = load_workbook(path, read_only=False, data_only=False, keep_vba=True)
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
headers = [str(ms.cell(1, c).value or "").strip() for c in range(1, 14)]
out["masterHeaders"] = headers
last_m = last_row(ms, 2)
out["masterDataRows"] = max(0, last_m - 1)
out["kSha256"] = hashlib.sha256(col_join(ms, 11, last_m).encode("utf-8")).hexdigest()
out["mSha256"] = hashlib.sha256(col_join(ms, 13, last_m).encode("utf-8")).hexdigest()
out["jrSha256"] = hashlib.sha256(col_join(ms, 2, last_m).encode("utf-8")).hexdigest()

ps = wb["Posted Sheet"]
last_p = last_row(ps, 1)
posted = []
for c in range(1, 4):
    posted.append(col_join(ps, c, last_p))
out["postedHeaders"] = [str(ps.cell(1, c).value or "").strip() for c in range(1, 4)]
out["postedSha256"] = hashlib.sha256("\\n---\\n".join(posted).encode("utf-8")).hexdigest()
out["postedRows"] = max(0, last_p - 1)

ns = wb["New Sheet"]
last_n = last_row(ns, 2)
nd = []
for r in range(1, last_n + 1):
    nd.append("|".join(str(ns.cell(r, c).value or "").strip() for c in range(1, 11)))
out["newHeaders"] = [str(ns.cell(1, c).value or "").strip() for c in range(1, 11)]
out["newSha256"] = hashlib.sha256("\\n".join(nd).encode("utf-8")).hexdigest()
out["newRows"] = max(0, last_n - 1)
wb.close()
print(json.dumps(out))
`.trim();

const ZIP_DIFF_PY = `
import json, sys, zipfile, hashlib, os, tempfile, shutil

before = sys.argv[1]
after = sys.argv[2]
restore_vba = sys.argv[3] == "1"
out_path = sys.argv[4] if len(sys.argv) > 4 else ""

def parts(p):
    with zipfile.ZipFile(p) as z:
        return {n: hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if not n.endswith("/")}

def vba_name(p):
    with zipfile.ZipFile(p) as z:
        names = [n for n in z.namelist() if n.lower().endswith("vbaproject.bin")]
        return names[0] if names else None

b = parts(before)
a = parts(after)
changed = sorted(set(b) | set(a))
diffs = []
for n in changed:
    if b.get(n) != a.get(n):
        diffs.append(n)

vba_name_b = vba_name(before)
vba_changed = vba_name_b in diffs if vba_name_b else True
restored = False
if restore_vba and vba_changed and vba_name_b:
    tmp = after + ".vba-restore.zip"
    with zipfile.ZipFile(before) as zb, zipfile.ZipFile(after) as za, zipfile.ZipFile(tmp, "w") as zo:
        original_vba = zb.read(vba_name_b)
        for info in za.infolist():
            data = original_vba if info.filename.lower().endswith("vbaproject.bin") else za.read(info.filename)
            zo.writestr(info, data)
    os.replace(tmp, after)
    restored = True
    a = parts(after)
    diffs = [n for n in sorted(set(b) | set(a)) if b.get(n) != a.get(n)]
    vba_changed = vba_name_b in diffs

allowed = []
for n in diffs:
    ln = n.lower()
    if "pivottables" in ln or "pivotcache" in ln:
        allowed.append(n)
    elif ln.endswith("calcchain.xml"):
        allowed.append(n)
    elif "workbook.xml" == ln.split("/")[-1]:
        allowed.append(n)

unexpected = [n for n in diffs if n not in allowed]
print(json.dumps({
    "ok": True,
    "changed": diffs,
    "allowed": allowed,
    "unexpected": unexpected,
    "vbaChanged": vba_changed,
    "vbaRestored": restored,
    "vbaPresent": vba_name(after) is not None,
}))
`.trim();

async function writeReport(dir: string, report: Report) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "step92-report.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );
}

async function fail(report: Report, backupDir: string): Promise<never> {
  report.ok = false;
  const cp = await readLateralGmailCheckpoint().catch(() => null);
  report.checkpointAfter = cp?.messageId ?? report.checkpointBefore ?? null;
  await writeReport(backupDir, report);
  console.error("\n=== STEP 9.2 FAILED ===");
  console.error("Stage:", report.stage);
  console.error("Failure:", report.failure);
  console.error("Production upload occurred:", report.uploadOccurred ? "YES" : "NO");
  console.error("Backup:", report.backupPath);
  process.exit(1);
}

async function downloadDriveFile(
  drive: Awaited<ReturnType<typeof getAuthorizedGmailClient>>["drive"],
  dest: string
) {
  const media = await drive.files.get(
    { fileId: EXPECTED_FILE_ID, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(dest, Buffer.from(media.data as ArrayBuffer));
}

function sameList(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameSet(a: unknown, b: string[]): boolean {
  const left = Array.isArray(a) ? [...a].map(String).sort() : [];
  const right = [...b].sort();
  return JSON.stringify(left) === JSON.stringify(right);
}

async function main() {
  console.log("=== STEP 9.2 — P-Roles JML order only (no Run All / no Gmail) ===\n");
  const backupDir = path.join(BACKUP_ROOT, stamp());
  await fs.mkdir(backupDir, { recursive: true });
  const report: Report = {
    ok: false,
    stage: "preflight",
    productionModified: false,
    uploadOccurred: false,
    fileId: EXPECTED_FILE_ID,
    backupPath: backupDir,
  };

  const checkpointBefore = await readLateralGmailCheckpoint();
  report.checkpointBefore = checkpointBefore.messageId;
  if (checkpointBefore.messageId !== EXPECTED_CHECKPOINT) {
    report.failure = `Checkpoint is ${checkpointBefore.messageId}, expected ${EXPECTED_CHECKPOINT}.`;
    return fail(report, backupDir);
  }
  console.log("Checkpoint (read-only):", checkpointBefore.messageId);

  const { drive } = await getAuthorizedGmailClient();
  const beforeMeta = await drive.files.get({
    fileId: EXPECTED_FILE_ID,
    fields: "id,name,size,modifiedTime,md5Checksum,mimeType,trashed",
    supportsAllDrives: true,
  });
  report.productionBefore = beforeMeta.data as Record<string, unknown>;
  console.log("Production before:", JSON.stringify(beforeMeta.data, null, 2));
  if (beforeMeta.data.trashed) {
    report.failure = "Production Master is trashed.";
    return fail(report, backupDir);
  }
  if (beforeMeta.data.id !== EXPECTED_FILE_ID || (beforeMeta.data.name || "") !== EXPECTED_NAME) {
    report.failure = "Production identity mismatch.";
    return fail(report, backupDir);
  }

  report.stage = "download";
  const workPath = path.join(os.tmpdir(), `step92-work-${Date.now()}.xlsm`);
  await downloadDriveFile(drive, workPath);

  report.stage = "backup";
  const backupFile = path.join(backupDir, EXPECTED_NAME);
  await fs.copyFile(workPath, backupFile);
  report.backupSha256 = await hashFile(backupFile, "sha256");
  report.backupMd5 = await hashFile(backupFile, "md5");
  report.backupSize = (await fs.stat(backupFile)).size;
  console.log("Backup SHA256:", report.backupSha256);
  console.log("Backup MD5:   ", report.backupMd5);
  console.log("Backup size:  ", report.backupSize);
  console.log("Backup path:  ", backupFile);

  report.stage = "inspect";
  const fpBefore = (await runPython(FINGERPRINT_PY, [backupFile], 180_000)) as Record<string, unknown>;
  const comBefore = await runCom("inspect", backupFile);
  report.fingerprintsBefore = {
    kSha256: fpBefore.kSha256,
    mSha256: fpBefore.mSha256,
    jrSha256: fpBefore.jrSha256,
    postedSha256: fpBefore.postedSha256,
    newSha256: fpBefore.newSha256,
    vba: fpBefore.vba,
    vbaSha256: fpBefore.vbaSha256,
    sheets: fpBefore.sheets,
    masterHeaders: fpBefore.masterHeaders,
    masterDataRows: fpBefore.masterDataRows,
    postedHeaders: fpBefore.postedHeaders,
    pivotXmlCount: fpBefore.pivotXmlCount,
  };
  report.oldJmlOrder = (comBefore.jmlOrder as string[]) || [];
  report.pivot = comBefore;
  console.log("Sheets:", fpBefore.sheets);
  console.log("VBA:", fpBefore.vba, fpBefore.vbaSha256);
  console.log("Pivot COM:", comBefore.pivotName, "count=", comBefore.pivotCount);
  console.log("JML before:", report.oldJmlOrder.join(" → "));
  console.log("Posted filter items:", comBefore.postedItems);
  console.log("Posted visible:", comBefore.postedVisible);
  console.log("Job Status visible count:", (comBefore.jobStatusVisible as string[] | undefined)?.length);
  console.log("Market Map visible count:", (comBefore.marketMapVisible as string[] | undefined)?.length);
  console.log("Source:", comBefore.sourceData);
  console.log("Value fields:", comBefore.valueFields);

  if (!fpBefore.vba || fpBefore.pivotXmlCount !== 1) {
    report.failure = "Precheck failed: VBA missing or pivot count != 1.";
    return fail(report, backupDir);
  }
  if (comBefore.ok !== true || comBefore.pivotName !== "P-Roles" || comBefore.pivotCount !== 1) {
    report.failure = `P-Roles inspect failed: ${JSON.stringify(comBefore)}`;
    return fail(report, backupDir);
  }
  const structureOk =
    sameSet(comBefore.rowFields, ["Primary Skills", "Skill Categorization"]) &&
    sameSet(comBefore.columnFields, ["Job Management Level"]) &&
    sameSet(comBefore.pageFields, ["Job Status", "Posted", "Market Map"]);
  if (!structureOk) {
    report.failure = `Unexpected pivot structure: ${JSON.stringify({
      rows: comBefore.rowFields,
      cols: comBefore.columnFields,
      pages: comBefore.pageFields,
    })}`;
    return fail(report, backupDir);
  }
  const values = (comBefore.valueFields as string[]) || [];
  if (!values.some((v) => v.includes("Job Requisition ID"))) {
    report.failure = `Value field is ${JSON.stringify(values)}, expected Count of Job Requisition ID.`;
    return fail(report, backupDir);
  }

  report.stage = "apply";
  const applied = await runCom("apply", workPath);
  if (applied.ok !== true) {
    report.failure = `JML Position apply failed: ${applied.error || JSON.stringify(applied)}`;
    return fail(report, backupDir);
  }
  console.log("Applied JML order:", JSON.stringify((applied.after as { jmlOrder?: string[] })?.jmlOrder));

  report.stage = "vba-gate";
  const zipDiff = (await runPython(ZIP_DIFF_PY, [backupFile, workPath, "1"], 120_000)) as {
    changed?: string[];
    unexpected?: string[];
    vbaChanged?: boolean;
    vbaRestored?: boolean;
    vbaPresent?: boolean;
  };
  report.zipDiff = zipDiff;
  report.vba = {
    beforeSha256: fpBefore.vbaSha256,
    restored: zipDiff.vbaRestored,
    present: zipDiff.vbaPresent,
    changedAfterRestore: zipDiff.vbaChanged,
  };
  console.log("Zip changed parts:", zipDiff.changed);
  console.log("Zip unexpected (packaging):", zipDiff.unexpected);
  console.log("VBA restored:", zipDiff.vbaRestored, "VBA still changed:", zipDiff.vbaChanged);

  if (!zipDiff.vbaPresent) {
    report.failure = "vbaProject.bin missing after save. Production commit aborted.";
    return fail(report, backupDir);
  }
  if (zipDiff.vbaChanged) {
    report.failure =
      "Excel/COM save would materially alter vbaProject.bin and restore did not return the original bytes. Production commit aborted.";
    return fail(report, backupDir);
  }

  report.stage = "verify";
  const fpAfter = (await runPython(FINGERPRINT_PY, [workPath], 180_000)) as Record<string, unknown>;
  const comAfter = await runCom("inspect", workPath);
  report.fingerprintsAfter = {
    kSha256: fpAfter.kSha256,
    mSha256: fpAfter.mSha256,
    jrSha256: fpAfter.jrSha256,
    postedSha256: fpAfter.postedSha256,
    newSha256: fpAfter.newSha256,
    vba: fpAfter.vba,
    vbaSha256: fpAfter.vbaSha256,
  };
  report.newJmlOrder = (comAfter.jmlOrder as string[]) || [];
  console.log("JML after:", report.newJmlOrder.join(" → "));

  const checks: string[] = [];
  if (fpAfter.kSha256 !== fpBefore.kSha256) checks.push("Master K fingerprint changed");
  if (fpAfter.mSha256 !== fpBefore.mSha256) checks.push("Master M fingerprint changed");
  if (fpAfter.jrSha256 !== fpBefore.jrSha256) checks.push("Master JR fingerprint changed");
  if (fpAfter.postedSha256 !== fpBefore.postedSha256) checks.push("Posted A/B/C fingerprint changed");
  if (fpAfter.newSha256 !== fpBefore.newSha256) checks.push("New Sheet fingerprint changed");
  if (fpAfter.vbaSha256 !== fpBefore.vbaSha256) checks.push("VBA hash changed");
  if (!fpAfter.vba) checks.push("VBA missing");
  if (fpAfter.pivotXmlCount !== 1) checks.push(`pivot xml count ${fpAfter.pivotXmlCount}`);
  if (JSON.stringify(fpAfter.sheets) !== JSON.stringify(fpBefore.sheets)) checks.push("sheet list changed");
  if (comAfter.pivotName !== "P-Roles") checks.push(`COM name ${comAfter.pivotName}`);
  if (comAfter.pivotCount !== 1) checks.push(`pivot count ${comAfter.pivotCount}`);
  if (!sameList(report.newJmlOrder.slice(0, 5), JML_CANONICAL)) {
    checks.push(`JML order ${report.newJmlOrder.join(" → ")}`);
  }
  if (comAfter.sourceData !== comBefore.sourceData) checks.push("pivot source changed");
  if (!sameList(comAfter.postedVisible, comBefore.postedVisible)) checks.push("Posted filter changed");
  if (!sameList(comAfter.jobStatusVisible, comBefore.jobStatusVisible)) checks.push("Job Status filter changed");
  if (!sameList(comAfter.marketMapVisible, comBefore.marketMapVisible)) checks.push("Market Map filter changed");
  if (!sameList(comAfter.rowFields, comBefore.rowFields)) checks.push("row fields changed");
  if (!sameList(comAfter.columnFields, comBefore.columnFields)) checks.push("column fields changed");
  if (!sameList(comAfter.pageFields, comBefore.pageFields)) checks.push("page fields changed");
  if (!sameList(comAfter.valueFields, comBefore.valueFields)) checks.push("value fields changed");
  if (checks.length) {
    report.failure = checks.join(" | ");
    report.pivot = { before: comBefore, after: comAfter };
    return fail(report, backupDir);
  }

  const checkpointMid = await readLateralGmailCheckpoint();
  if (checkpointMid.messageId !== EXPECTED_CHECKPOINT) {
    report.checkpointAfter = checkpointMid.messageId;
    report.failure = "Gmail checkpoint changed before upload.";
    return fail(report, backupDir);
  }

  report.stage = "upload";
  console.log("\nAll checks passed. Uploading to the same Drive file ID…");
  await drive.files.update({
    fileId: EXPECTED_FILE_ID,
    requestBody: { name: EXPECTED_NAME, mimeType: XLSM_MIME },
    media: { mimeType: XLSM_MIME, body: createReadStream(workPath) },
    fields: "id,name,size,modifiedTime,md5Checksum,mimeType",
    supportsAllDrives: true,
  });
  report.uploadOccurred = true;
  report.productionModified = true;

  report.stage = "post-verify";
  const afterMeta = await drive.files.get({
    fileId: EXPECTED_FILE_ID,
    fields: "id,name,size,modifiedTime,md5Checksum,mimeType",
    supportsAllDrives: true,
  });
  report.productionAfter = afterMeta.data as Record<string, unknown>;
  if (afterMeta.data.id !== EXPECTED_FILE_ID || (afterMeta.data.name || "") !== EXPECTED_NAME) {
    report.failure = "Drive identity changed after upload.";
    return fail(report, backupDir);
  }

  const verifyPath = path.join(os.tmpdir(), `step92-verify-${Date.now()}.xlsm`);
  await downloadDriveFile(drive, verifyPath);
  report.finalSha256 = await hashFile(verifyPath, "sha256");
  const fpVerify = (await runPython(FINGERPRINT_PY, [verifyPath], 180_000)) as Record<string, unknown>;
  const comVerify = await runCom("inspect", verifyPath);
  if (
    fpVerify.kSha256 !== fpBefore.kSha256 ||
    fpVerify.mSha256 !== fpBefore.mSha256 ||
    fpVerify.postedSha256 !== fpBefore.postedSha256 ||
    fpVerify.vbaSha256 !== fpBefore.vbaSha256 ||
    comVerify.pivotName !== "P-Roles" ||
    comVerify.pivotCount !== 1 ||
    !sameList(((comVerify.jmlOrder as string[]) || []).slice(0, 5), JML_CANONICAL)
  ) {
    report.failure = `Post-upload verify failed: JML=${JSON.stringify(comVerify.jmlOrder)} VBA=${fpVerify.vbaSha256}`;
    return fail(report, backupDir);
  }

  const checkpointAfter = await readLateralGmailCheckpoint();
  report.checkpointAfter = checkpointAfter.messageId;
  if (checkpointAfter.messageId !== EXPECTED_CHECKPOINT) {
    report.failure = `Checkpoint changed to ${checkpointAfter.messageId}`;
    return fail(report, backupDir);
  }

  report.ok = true;
  report.pivot = { before: comBefore, after: comVerify };
  await writeReport(backupDir, report);
  await fs.unlink(workPath).catch(() => undefined);
  await fs.unlink(verifyPath).catch(() => undefined);

  console.log("\n=== STEP 9.2 PASS ===");
  console.log("1. Old JML order:", report.oldJmlOrder.join(" → "));
  console.log("2. New JML order:", ((comVerify.jmlOrder as string[]) || []).join(" → "));
  console.log("3. PivotTable COM name:", comVerify.pivotName);
  console.log("4. Pivot count:", comVerify.pivotCount);
  console.log("5. Pivot structure: rows=", comVerify.rowFields, " cols=", comVerify.columnFields, " filters=", comVerify.pageFields);
  console.log("6. Value field:", comVerify.valueFields);
  console.log("7. Pivot source:", comVerify.sourceData);
  console.log("8. Posted filter:", comVerify.postedItems, " visible=", comVerify.postedVisible);
  console.log("9. Job Status visible count:", (comVerify.jobStatusVisible as string[])?.length);
  console.log("10. Market Map visible count:", (comVerify.marketMapVisible as string[])?.length);
  console.log("11. Master K:", fpBefore.kSha256, "===", fpVerify.kSha256);
  console.log("12. Master M:", fpBefore.mSha256, "===", fpVerify.mSha256);
  console.log("13. Posted A/B/C:", fpBefore.postedSha256, "===", fpVerify.postedSha256);
  console.log("14. VBA:", fpBefore.vbaSha256, "===", fpVerify.vbaSha256);
  console.log("15. Production file ID:", EXPECTED_FILE_ID);
  console.log("16. SHA256 before/after:", report.backupSha256, "→", report.finalSha256);
  console.log("17. Production upload occurred: YES");
  console.log("18. PASS");
}

void main().catch((err) => {
  console.error("STEP 9.2 crashed:", err);
  process.exit(1);
});
