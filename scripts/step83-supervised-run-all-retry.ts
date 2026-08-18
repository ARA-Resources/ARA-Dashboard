/**
 * STEP 8.3 — Supervised production Run All retry (once).
 * Same entry as Dataset Run All: invokeLateralJob("manual")
 *   == POST /api/dataset/lateral/scheduler { action: "run_now" }
 *
 * No automatic retry. No architecture changes.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import { readLateralGmailCheckpoint } from "../src/services/lateral-processing/lateral-gmail-checkpoint-store";
import { invokeLateralJob } from "../src/services/lateral-processing/lateral-scheduler";
import { readHomeWidgetsMetricsSnapshot } from "../src/services/home/home-widgets-metrics-store";

const execFileAsync = promisify(execFile);

const FILE_ID = "1ztfWeVhDyzYOHlvA8ujzvtSapRDvvPw9";
const EXPECTED_SHA256 =
  "c38c3da77348e11b18cdfe5d6eb420b30e65e1d298672b090e01dfed1d51b387";
const EXPECTED_MD5 = "12f96309a18bea6cff851f96beb58236";
const EXPECTED_CHECKPOINT = "19ffa890d265dde2";
const BACKUP_DIR =
  "D:\\ARA Resources\\Dashboard New\\backups\\lateral-step8\\2026-08-17T10-37-19-792Z";
const REPORT_DIR = path.join(BACKUP_DIR, "..", "step83-retry");

function hashBuffer(buf: Buffer, algo: "sha256" | "md5"): string {
  return createHash(algo).update(buf).digest("hex");
}

async function inspectXlsm(filePath: string) {
  const script = `
import json, sys, zipfile
from xml.etree import ElementTree as ET
from openpyxl import load_workbook
path = sys.argv[1]
out = {}
with zipfile.ZipFile(path) as z:
    names = z.namelist()
    out["vba"] = any(n.lower().endswith("vbaproject.bin") for n in names)
    pivots = [n for n in names if n.lower().startswith("xl/pivottables/") and n.endswith(".xml") and "/_rels/" not in n]
    out["pivotXmlCount"] = len(pivots)
    out["pivotNames"] = []
    for n in pivots:
        root = ET.fromstring(z.read(n))
        out["pivotNames"].append(root.attrib.get("name"))
wb = load_workbook(path, read_only=True, data_only=True)
out["sheets"] = wb.sheetnames
out["missing"] = [s for s in ["Master Sheet","New Sheet","Posted Sheet","P-Roles"] if s not in wb.sheetnames]
if "Master Sheet" in wb.sheetnames:
    h = [str(c or "").strip() for c in next(wb["Master Sheet"].iter_rows(min_row=1, max_row=1, max_col=13, values_only=True))]
    out["colK"] = h[10] if len(h)>10 else ""
    out["colM"] = h[12] if len(h)>12 else ""
    out["headers"] = h
wb.close()
print(json.dumps(out))
`.trim();
  const p = path.join(os.tmpdir(), `step83-inspect-${Date.now()}.py`);
  await fs.writeFile(p, script, "utf8");
  try {
    const { stdout } = await execFileAsync("python", [p, filePath], {
      windowsHide: true,
      timeout: 180_000,
    });
    return JSON.parse((stdout || "").trim() || "{}");
  } finally {
    await fs.unlink(p).catch(() => undefined);
  }
}

async function downloadMaster(drive: Awaited<ReturnType<typeof getAuthorizedGmailClient>>["drive"]) {
  const meta = await drive.files.get({
    fileId: FILE_ID,
    fields: "id,name,size,modifiedTime,md5Checksum,mimeType",
    supportsAllDrives: true,
  });
  const media = await drive.files.get(
    { fileId: FILE_ID, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  const buf = Buffer.from(media.data as ArrayBuffer);
  return { meta: meta.data, buf };
}

async function main() {
  console.log("=== STEP 8.3 — Supervised production Run All retry ===\n");
  await fs.mkdir(REPORT_DIR, { recursive: true });

  const pipelineSrc = await fs.readFile(
    path.join(process.cwd(), "src/services/lateral-processing/pipeline.ts"),
    "utf8"
  );
  if (!pipelineSrc.includes("commitToProduction: false")) {
    console.error("STOP: commitToProduction: false is not active.");
    process.exit(1);
  }
  console.log("PASS  commitToProduction: false is active");

  const checkpointBefore = await readLateralGmailCheckpoint();
  if (checkpointBefore.messageId !== EXPECTED_CHECKPOINT) {
    console.error(
      `STOP: checkpoint is ${checkpointBefore.messageId}, expected ${EXPECTED_CHECKPOINT}`
    );
    process.exit(1);
  }
  console.log("PASS  Gmail checkpoint", checkpointBefore.messageId, checkpointBefore.attachmentFilename);

  const { drive } = await getAuthorizedGmailClient();
  const before = await downloadMaster(drive);
  const shaBefore = hashBuffer(before.buf, "sha256");
  const md5Before = hashBuffer(before.buf, "md5");
  console.log("Production before:", {
    id: before.meta.id,
    size: before.meta.size,
    modifiedTime: before.meta.modifiedTime,
    driveMd5: before.meta.md5Checksum,
    sha256: shaBefore,
    md5: md5Before,
  });

  if (shaBefore !== EXPECTED_SHA256 || md5Before !== EXPECTED_MD5) {
    console.error("STOP: production Master is not the restored pre-Step-8 content.");
    process.exit(1);
  }

  const tmp = path.join(os.tmpdir(), `step83-pre-${Date.now()}.xlsm`);
  await fs.writeFile(tmp, before.buf);
  const inspect = await inspectXlsm(tmp);
  await fs.unlink(tmp).catch(() => undefined);

  const preOk =
    (inspect.missing?.length ?? 1) === 0 &&
    inspect.vba &&
    inspect.pivotXmlCount === 1 &&
    /job status/i.test(inspect.colK || "") &&
    /posted/i.test(inspect.colM || "");
  if (!preOk) {
    console.error("STOP: pre-run workbook integrity failed", inspect);
    process.exit(1);
  }
  console.log("PASS  XLSM/VBA/sheets/pivot/K/M", inspect.pivotNames, inspect.colK, inspect.colM);

  const homeBefore = await readHomeWidgetsMetricsSnapshot();
  const md5Samples: Array<{ at: string; md5: string | null; modifiedTime: string | null }> = [
    {
      at: new Date().toISOString(),
      md5: before.meta.md5Checksum ?? md5Before,
      modifiedTime: before.meta.modifiedTime ?? null,
    },
  ];

  const poll = setInterval(() => {
    void drive.files
      .get({
        fileId: FILE_ID,
        fields: "md5Checksum,modifiedTime,size",
        supportsAllDrives: true,
      })
      .then((res) => {
        md5Samples.push({
          at: new Date().toISOString(),
          md5: res.data.md5Checksum ?? null,
          modifiedTime: res.data.modifiedTime ?? null,
        });
        console.log(
          `[poll] md5=${res.data.md5Checksum} modified=${res.data.modifiedTime} size=${res.data.size}`
        );
      })
      .catch(() => undefined);
  }, 15000);

  console.log("\nStarting Run All: invokeLateralJob('manual') [= POST action=run_now]\n");
  const started = Date.now();
  let outcome: Awaited<ReturnType<typeof invokeLateralJob>>["outcome"];
  try {
    const result = await invokeLateralJob("manual");
    outcome = result.outcome;
  } finally {
    clearInterval(poll);
  }
  const durationMs = Date.now() - started;

  const checkpointAfter = await readLateralGmailCheckpoint();
  const homeAfter = await readHomeWidgetsMetricsSnapshot();
  const after = await downloadMaster(drive);
  const shaAfter = hashBuffer(after.buf, "sha256");
  const md5After = hashBuffer(after.buf, "md5");

  const afterPath = path.join(os.tmpdir(), `step83-post-${Date.now()}.xlsm`);
  await fs.writeFile(afterPath, after.buf);
  const inspectAfter = await inspectXlsm(afterPath);
  await fs.unlink(afterPath).catch(() => undefined);

  const productionChangedDuringPoll = md5Samples.some(
    (s) => s.md5 && s.md5 !== EXPECTED_MD5
  );
  const productionChangedFinal = shaAfter !== shaBefore;

  const report = {
    durationMs,
    outcome: {
      status: outcome.status,
      message: outcome.message,
      failure: outcome.failure ?? null,
      checkpointAdvanced: outcome.checkpointAdvanced,
      syncSummary: outcome.syncSummary ?? null,
    },
    productionBefore: {
      sha256: shaBefore,
      md5: md5Before,
      size: before.meta.size,
      modifiedTime: before.meta.modifiedTime,
    },
    productionAfter: {
      id: after.meta.id,
      name: after.meta.name,
      sha256: shaAfter,
      md5: md5After,
      size: after.meta.size,
      modifiedTime: after.meta.modifiedTime,
    },
    productionChangedFinal,
    md5Samples,
    inspectAfter,
    checkpointBefore: {
      messageId: checkpointBefore.messageId,
      attachmentFilename: checkpointBefore.attachmentFilename,
    },
    checkpointAfter: {
      messageId: checkpointAfter.messageId,
      attachmentFilename: checkpointAfter.attachmentFilename,
      receivedAt: checkpointAfter.receivedAt,
      processedAt: checkpointAfter.processedAt,
    },
    homeBefore: homeBefore?.units,
    homeAfter: homeAfter?.units,
    backup: BACKUP_DIR,
  };

  await fs.writeFile(
    path.join(REPORT_DIR, "result.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );

  console.log("\n========== STEP 8.3 RESULT ==========\n");
  console.log(`Job status: ${outcome.status}`);
  console.log(outcome.message);
  console.log(`Duration: ${durationMs} ms`);
  console.log(`Production ID: ${after.meta.id}`);
  console.log(`SHA256 before: ${shaBefore}`);
  console.log(`SHA256 after:  ${shaAfter}`);
  console.log(`Checkpoint: ${checkpointBefore.messageId} → ${checkpointAfter.messageId}`);
  console.log(`Report: ${path.join(REPORT_DIR, "result.json")}`);

  if (outcome.status === "failed" || outcome.failure?.isHardFailure) {
    process.exit(1);
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
