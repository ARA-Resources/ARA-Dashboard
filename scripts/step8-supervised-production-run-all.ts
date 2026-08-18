/**
 * STEP 8 — ONE supervised production Lateral Run All.
 *
 * Uses existing invokeLateralJob("manual") — same entry as Dataset "Run All".
 * Does not rewrite pipeline stages.
 *
 * Pre-flight + Gmail search-only first. Backup before any mutation.
 * If no new source: STOP without Drive/Master changes.
 *
 * Run: npx tsx scripts/step8-supervised-production-run-all.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getSharedGoogleConnectionStatus } from "../src/services/dataset/google-connection";
import { readDatasetSetup } from "../src/services/dataset/secure-store";
import { datasetCurrentDir } from "../src/services/dataset/paths";
import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import {
  getCalendarDateInTimezone,
  getStartOfCalendarDayMs,
} from "../src/services/gmail/query";
import { DEFAULT_FILE_TYPES } from "../src/types/dataset-setup";
import {
  buildLateralExcelDiscoveryQuery,
  discoverLateralExcelInMessage,
  sortLateralDiscoveriesChronologically,
} from "../src/services/lateral-processing/lateral-excel-discovery";
import {
  isAfterLateralGmailCheckpoint,
  readLateralGmailCheckpoint,
} from "../src/services/lateral-processing/lateral-gmail-checkpoint-store";
import { discoverLateralMasterWorkbook } from "../src/services/lateral-processing/lateral-master-workbook-discovery";
import { invokeLateralJob } from "../src/services/lateral-processing/lateral-scheduler";
import { readLateralDataProcessingSetup } from "../src/services/lateral-processing/setup-store";
import { readHomeWidgetsMetricsSnapshot } from "../src/services/home/home-widgets-metrics-store";
import { MASTER_JOB_STATUS_COLUMN_K } from "../src/services/lateral-processing/lateral-job-status-rules";
import { MASTER_POSTED_COLUMN_M } from "../src/services/lateral-processing/lateral-posted-sheet-processor";

const execFileAsync = promisify(execFile);

const BACKUP_ROOT = path.resolve(
  process.cwd(),
  "..",
  "backups",
  "lateral-step8"
);

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (d) => hash.update(d));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function runPython(script: string, args: string[]): Promise<unknown> {
  const scriptPath = path.join(
    process.env.TEMP || ".",
    `step8-${Date.now()}.py`
  );
  await fs.writeFile(scriptPath, script, "utf8");
  try {
    const { stdout, stderr } = await execFileAsync("python", [scriptPath, ...args], {
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (stderr && !stdout.trim()) {
      throw new Error(stderr.slice(0, 800));
    }
    return JSON.parse((stdout || "").trim() || "{}");
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

const INSPECT_PY = `
import json, sys, zipfile
from openpyxl import load_workbook

path = sys.argv[1]
out = {"ok": True, "sheets": [], "headers": {}, "vba": False, "pivotHint": False, "statusCounts": {}, "postedCounts": {}, "newSheetRows": 0, "masterRows": 0}

with zipfile.ZipFile(path) as z:
    names = z.namelist()
    out["vba"] = any(n.lower().endswith("vbaproject.bin") for n in names)
    out["pivotHint"] = any("pivottable" in n.lower() for n in names)
    out["xlsm"] = path.lower().endswith(".xlsm")

wb = load_workbook(path, read_only=True, data_only=True)
out["sheets"] = wb.sheetnames
required = ["Master Sheet", "New Sheet", "Posted Sheet", "P-Roles"]
out["missingSheets"] = [s for s in required if s not in wb.sheetnames]

if "Master Sheet" in wb.sheetnames:
    ms = wb["Master Sheet"]
    header_row = next(ms.iter_rows(min_row=1, max_row=1, max_col=18, values_only=True))
    out["headers"]["master"] = [str(c or "").strip() for c in header_row]
    k_counts = {}
    m_counts = {}
    n = 0
    for row in ms.iter_rows(min_row=2, max_col=13, values_only=True):
        jr = str(row[1] or "").strip() if len(row) > 1 else ""
        if not jr:
            continue
        n += 1
        k = str(row[10] or "").strip() if len(row) > 10 else ""
        m = str(row[12] or "").strip() if len(row) > 12 else ""
        k_counts[k] = k_counts.get(k, 0) + 1
        m_counts[m] = m_counts.get(m, 0) + 1
    out["masterRows"] = n
    out["statusCounts"] = k_counts
    out["postedCounts"] = m_counts

if "New Sheet" in wb.sheetnames:
    ns = wb["New Sheet"]
    header_row = next(ns.iter_rows(min_row=1, max_row=1, max_col=10, values_only=True))
    out["headers"]["newSheet"] = [str(c or "").strip() for c in header_row]
    n = 0
    dates = set()
    for row in ns.iter_rows(min_row=2, max_col=2, values_only=True):
        if any(str(c or "").strip() for c in row):
            n += 1
            dates.add(str(row[0] or "").strip())
    out["newSheetRows"] = n
    out["newSheetDates"] = sorted(dates)[:8]

if "Posted Sheet" in wb.sheetnames:
    ps = wb["Posted Sheet"]
    posted = 0
    sample = []
    for row in ps.iter_rows(min_row=2, max_col=1, values_only=True):
        v = str(row[0] or "").strip()
        if v:
            posted += 1
            if len(sample) < 3:
                sample.append(v[:160])
    out["postedRows"] = posted
    out["postedSamples"] = sample

wb.close()
print(json.dumps(out))
`.trim();

async function fail(msg: string): Promise<never> {
  console.error(`\nPRE-FLIGHT FAILED — RUN ALL NOT STARTED\n${msg}`);
  process.exit(1);
}

async function main() {
  console.log("=== STEP 8 — Supervised production Run All ===");
  console.log("Mode: ONE run via existing invokeLateralJob(manual)\n");

  const checks: string[] = [];
  const pass = (name: string, detail: string) => {
    checks.push(`PASS  ${name} — ${detail}`);
    console.log(`PASS  ${name}`);
    console.log(`      ${detail}`);
  };

  // ── 1. Connections ────────────────────────────────────────────────
  const connections = await getSharedGoogleConnectionStatus({ probeDrive: true });
  if (!connections.gmail?.connected) {
    await fail("Gmail is not connected.");
  }
  if (!connections.drive?.connected) {
    await fail("Google Drive is not connected.");
  }
  pass(
    "Gmail connection",
    `Connected (${connections.email ?? "unknown mailbox"})`
  );
  pass("Drive connection", "Connected");

  // ── 2. Config ─────────────────────────────────────────────────────
  const datasetSetup = await readDatasetSetup();
  if (!datasetSetup) await fail("Dataset setup is not configured.");
  const lateralDataset = datasetSetup.datasets?.Lateral;
  if (!lateralDataset || lateralDataset.enabled === false) {
    await fail("Lateral dataset is disabled in Dataset setup.");
  }
  const keywords = (lateralDataset.keywords ?? []).filter(
    (k) => k.enabled && k.value.trim()
  );
  if (keywords.length === 0) {
    await fail("Lateral Gmail keywords are not configured.");
  }
  pass(
    "Lateral Gmail keywords",
    `${keywords.length} enabled: ${keywords.map((k) => k.value).join(", ")}`
  );

  const processing = await readLateralDataProcessingSetup();
  if (!processing) await fail("Lateral Dataset Processing Setup is not configured.");
  if (!processing.masterWorkbook?.fileId) {
    await fail("Production Master workbook is not selected.");
  }
  const destFolder =
    processing.destinationFolder?.folderId ||
    processing.destinationFolder?.folderUrl;
  if (!destFolder) await fail("Lateral Drive destination is not configured.");
  pass(
    "Lateral processing config",
    `Master=${processing.masterWorkbook.fileName} id=${processing.masterWorkbook.fileId}`
  );
  pass(
    "Lateral Drive destination",
    processing.destinationFolder.folderName ||
      processing.destinationFolder.folderId ||
      "configured"
  );

  const checkpointBefore = await readLateralGmailCheckpoint();
  pass(
    "Gmail checkpoint",
    `messageId=${checkpointBefore.messageId} file=${checkpointBefore.attachmentFilename} at=${checkpointBefore.receivedAt}`
  );

  const homeBefore = await readHomeWidgetsMetricsSnapshot();
  const execBefore = homeBefore?.units?.executive?.totals ?? null;
  const consBefore = homeBefore?.units?.consulting?.totals ?? null;
  const latBefore = homeBefore?.units?.lateral ?? null;

  // ── 3. Production Master discovery (read-only) ────────────────────
  const discovery = await discoverLateralMasterWorkbook({ setup: processing });
  pass(
    "Production Master accessible",
    `${discovery.fileName} id=${discovery.fileId} sheets=${discovery.availableWorksheets.join(", ")}`
  );
  const required = ["Master Sheet", "New Sheet", "Posted Sheet", "P-Roles"];
  const missing = required.filter((s) => !discovery.availableWorksheets.includes(s));
  if (missing.length) {
    await fail(`Production workbook missing worksheets: ${missing.join(", ")}`);
  }
  pass("Required worksheets", required.join(", "));

  // ── 4. Backup (download copy — does not replace production) ───────
  await fs.mkdir(BACKUP_ROOT, { recursive: true });
  const backupDir = path.join(BACKUP_ROOT, stamp());
  await fs.mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, discovery.fileName);

  const { drive } = await getAuthorizedGmailClient();
  const meta = await drive.files.get({
    fileId: discovery.fileId,
    fields: "id,name,size,modifiedTime,md5Checksum,mimeType",
    supportsAllDrives: true,
  });
  const media = await drive.files.get(
    { fileId: discovery.fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  const buf = Buffer.from(media.data as ArrayBuffer);
  await fs.writeFile(backupPath, buf);
  const hash = await sha256File(backupPath);
  const backupManifest = {
    createdAt: new Date().toISOString(),
    workbookName: meta.data.name,
    driveFileId: discovery.fileId,
    sizeBytes: Number(meta.data.size || buf.length),
    modifiedTime: meta.data.modifiedTime ?? null,
    md5Checksum: meta.data.md5Checksum ?? null,
    sha256: hash,
    localBackupPath: backupPath,
    note: "Restorable copy. Production Drive file was not renamed or replaced.",
  };
  await fs.writeFile(
    path.join(backupDir, "manifest.json"),
    JSON.stringify(backupManifest, null, 2),
    "utf8"
  );
  pass(
    "Production Master backup",
    `${backupPath} size=${backupManifest.sizeBytes} sha256=${hash.slice(0, 16)}…`
  );

  const inspect = (await runPython(INSPECT_PY, [backupPath])) as {
    ok?: boolean;
    sheets?: string[];
    missingSheets?: string[];
    headers?: { master?: string[]; newSheet?: string[] };
    vba?: boolean;
    pivotHint?: boolean;
    xlsm?: boolean;
    statusCounts?: Record<string, number>;
    postedCounts?: Record<string, number>;
    masterRows?: number;
    newSheetRows?: number;
  };
  if (!inspect.xlsm) await fail("Production workbook is not XLSM.");
  if (!inspect.vba) await fail("VBA project (vbaProject.bin) not found.");
  if (!inspect.pivotHint) await fail("No PivotTable artifacts found in workbook zip.");
  const masterHeaders = inspect.headers?.master ?? [];
  const kHeader = (masterHeaders[MASTER_JOB_STATUS_COLUMN_K - 1] || "").toLowerCase();
  const mHeader = (masterHeaders[MASTER_POSTED_COLUMN_M - 1] || "").toLowerCase();
  if (!kHeader.includes("job status")) {
    await fail(`Column K is not Job Status (found "${masterHeaders[10]}")`);
  }
  if (mHeader !== "posted") {
    await fail(`Column M is not Posted (found "${masterHeaders[12]}")`);
  }
  pass("Workbook integrity (pre)", "XLSM + VBA + PivotTable artifacts");
  pass(
    "Master columns K / M",
    `K="${masterHeaders[10]}" M="${masterHeaders[12]}" rows=${inspect.masterRows}`
  );

  // ── 5. Gmail search-only (no attachment download, no Drive write) ─
  const afterMs =
    checkpointBefore.receivedAtMs ??
    getStartOfCalendarDayMs(getCalendarDateInTimezone());
  const queryAfterMs = Math.max(0, afterMs - 2000);
  const fileTypes =
    lateralDataset.fileTypes?.length > 0
      ? lateralDataset.fileTypes
      : DEFAULT_FILE_TYPES;
  const query = buildLateralExcelDiscoveryQuery({
    afterMs: queryAfterMs,
    keywords: lateralDataset.keywords,
    fileTypes,
  });
  console.log(`\nGmail search (incremental): ${query}\n`);

  const { gmail } = await getAuthorizedGmailClient();
  const list = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 100,
  });
  const messageRefs = list.data.messages ?? [];
  const discoveries = [];
  for (const ref of messageRefs) {
    if (!ref.id) continue;
    const full = await gmail.users.messages.get({
      userId: "me",
      id: ref.id,
      format: "full",
    });
    const discovered = discoverLateralExcelInMessage(full.data, {
      keywords: lateralDataset.keywords,
      fileTypes,
    });
    if (!discovered) continue;
    const selected = discovered.selection.selected;
    if (
      !isAfterLateralGmailCheckpoint(
        {
          messageId: selected.messageId,
          attachmentId: selected.attachmentId,
          receivedAtMs: selected.receivedAtMs,
        },
        checkpointBefore
      )
    ) {
      continue;
    }
    discoveries.push(discovered);
  }
  const queue = sortLateralDiscoveriesChronologically(discoveries);

  if (queue.length === 0) {
    console.log("No new Lateral dataset found.");
    console.log(
      "Drive, Master Sheet, New Sheet, Column K, Column M, Posted Sheet, and P-Roles were NOT modified."
    );
    console.log(`Backup retained at: ${backupPath}`);
    await fs.writeFile(
      path.join(backupDir, "result.json"),
      JSON.stringify(
        {
          overall: "NO_NEW_SOURCE",
          message: "No new Lateral dataset found.",
          checkpointBefore,
          backup: backupManifest,
        },
        null,
        2
      ),
      "utf8"
    );
    process.exit(0);
  }

  const newest = queue[queue.length - 1];
  pass(
    "New Gmail source found",
    `${queue.length} email(s). Newest: ${newest.sender} · ${newest.subject} · ${newest.selection.selected.attachmentName} · ${newest.receivedAt}`
  );

  // ── 6. ONE production Run All ─────────────────────────────────────
  console.log("\nStarting existing Run All: invokeLateralJob('manual') …\n");
  const startedAt = Date.now();
  const result = await invokeLateralJob("manual");
  const durationMs = Date.now() - startedAt;
  const outcome = result.outcome;
  const checkpointAfter = await readLateralGmailCheckpoint();
  const homeAfter = await readHomeWidgetsMetricsSnapshot();

  console.log(`\nJob status: ${outcome.status}`);
  console.log(`Message: ${outcome.message}`);
  console.log(`Duration: ${durationMs} ms`);

  if (outcome.status === "failed" || outcome.failure?.isHardFailure) {
    console.error("\nRUN ALL FAILED — stopped. Backup preserved. No retry.");
    console.error(`Failed stage: ${outcome.failure?.failedStage ?? "unknown"}`);
    console.error(outcome.failure?.message ?? outcome.message);
    await fs.writeFile(
      path.join(backupDir, "result.json"),
      JSON.stringify(
        {
          overall: "FAILED",
          failedStage: outcome.failure?.failedStage ?? null,
          outcome,
          checkpointBefore,
          checkpointAfter,
          backup: backupManifest,
        },
        null,
        2
      ),
      "utf8"
    );
    process.exit(1);
  }

  // ── 7. Post-run inspection of Dataset Manager current copy ────────
  const currentDir = datasetCurrentDir("Lateral");
  let currentFile: string | null = null;
  if (existsSync(currentDir)) {
    const files = await fs.readdir(currentDir);
    const xlsm = files.find((f) => /\.xlsm$/i.test(f));
    if (xlsm) currentFile = path.join(currentDir, xlsm);
  }

  let postInspect: typeof inspect | null = null;
  if (currentFile && existsSync(currentFile)) {
    postInspect = (await runPython(INSPECT_PY, [currentFile])) as typeof inspect;
  }

  const afterMeta = await drive.files.get({
    fileId: discovery.fileId,
    fields: "id,name,size,modifiedTime,md5Checksum",
    supportsAllDrives: true,
  });

  const latAfter = homeAfter?.units?.lateral ?? null;
  const execAfter = homeAfter?.units?.executive?.totals ?? null;
  const consAfter = homeAfter?.units?.consulting?.totals ?? null;

  const masterPostedYes = postInspect?.postedCounts?.Yes ?? null;
  const masterPostedDash = postInspect?.postedCounts?.["-"] ?? null;

  const report = {
    overall:
      outcome.status === "success"
        ? "SUCCESS"
        : outcome.status === "partial"
          ? "PARTIAL"
          : "FAILED",
    gmail: {
      sourceEmailFound: `${newest.sender} · ${newest.subject}`,
      sourceFileName: newest.selection.selected.attachmentName,
      emailsInQueue: queue.length,
      checkpointBefore: {
        messageId: checkpointBefore.messageId,
        receivedAt: checkpointBefore.receivedAt,
        attachmentFilename: checkpointBefore.attachmentFilename,
      },
      checkpointAfter: {
        messageId: checkpointAfter.messageId,
        receivedAt: checkpointAfter.receivedAt,
        attachmentFilename: checkpointAfter.attachmentFilename,
        processedAt: checkpointAfter.processedAt,
        processingResult: checkpointAfter.processingResult,
      },
    },
    drive: {
      sourceUploaded: outcome.syncSummary?.originalFilename ?? null,
      sourceDriveFileId: outcome.syncSummary?.googleDriveFileId ?? null,
      finalMasterName: afterMeta.data.name,
      finalMasterId: afterMeta.data.id,
      finalModifiedTime: afterMeta.data.modifiedTime,
      finalSize: afterMeta.data.size,
      finalMd5: afterMeta.data.md5Checksum ?? null,
    },
    newSheet: {
      rowsImported: outcome.syncSummary?.rowsImported ?? postInspect?.newSheetRows,
      dates: postInspect && "newSheetDates" in postInspect ? (postInspect as { newSheetDates?: string[] }).newSheetDates : null,
      headers: postInspect?.headers?.newSheet ?? null,
    },
    master: {
      totalRows: postInspect?.masterRows ?? null,
      active: postInspect?.statusCounts?.Active ?? outcome.syncSummary?.activeCount,
      new: postInspect?.statusCounts?.New ?? outcome.syncSummary?.newCount,
      closed: postInspect?.statusCounts?.Closed ?? outcome.syncSummary?.closedCount,
      reopen: postInspect?.statusCounts?.Reopen ?? outcome.syncSummary?.reopenCount,
      columnMYes: masterPostedYes,
      columnMDash: masterPostedDash,
    },
    postedSheet: {
      note: "Counts from pipeline outcome / current Dataset Manager copy",
      validAtciRows: postInspect && "postedRows" in postInspect ? (postInspect as { postedRows?: number }).postedRows : null,
      samples:
        postInspect && "postedSamples" in postInspect
          ? (postInspect as { postedSamples?: string[] }).postedSamples
          : null,
    },
    pRoles: {
      pivotArtifactsPresent: postInspect?.pivotHint ?? inspect.pivotHint,
      masterPostedYes,
      note: "PivotTable1 refresh is pipeline step 19; cross-check uses Master Column M Yes count vs Home posted when available",
      homePosted: latAfter?.posted ?? null,
      difference:
        masterPostedYes != null && latAfter?.posted != null
          ? Math.abs(masterPostedYes - latAfter.posted)
          : null,
    },
    home: {
      lateral: latAfter,
      executive: { before: execBefore, after: execAfter },
      consulting: { before: consBefore, after: consAfter },
      executiveUnchanged: execBefore === execAfter,
      consultingUnchanged: consBefore === consAfter,
    },
    backup: backupManifest,
    outcomeMessage: outcome.message,
    durationMs,
  };

  await fs.writeFile(
    path.join(backupDir, "result.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );

  console.log("\n========== PRODUCTION REPORT ==========\n");
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nBackup + report: ${backupDir}`);
  console.log("Step 9 not started.");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
