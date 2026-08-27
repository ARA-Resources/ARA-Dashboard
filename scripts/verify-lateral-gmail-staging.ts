/**
 * Phase 3A tests — Gmail/Drive → ATCI DS → lateral_staging orchestration.
 *
 * Run: npm run test:lateral-gmail-staging
 * (also chained from test:lateral-staging)
 *
 * No live Gmail required — acquisition / checkpoint are injected.
 * Does NOT truncate production lateral_master.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postgres from "postgres";
import {
  buildLateralExcelDiscoveryQuery,
  buildLateralKeywordSearchClause,
  selectLateralExcelAttachment,
} from "../src/services/lateral-processing/lateral-excel-discovery";
import type { RawGmailAttachment } from "../src/services/gmail/attachments";
import type { DatasetKeywordConfig } from "../src/types/dataset-setup";
import {
  executeLateralGmailStagingJob,
} from "../src/services/lateral-processing/lateral-gmail-staging-job";
import type {
  LateralIncrementalSyncResult,
  LateralPendingCheckpointAdvance,
} from "../src/services/lateral-processing/lateral-gmail-incremental-sync";
import {
  getRuntimeProcessingDateIso,
  importAtciDsWorkbookToStaging,
} from "../src/services/lateral-processing/lateral-staging-import";
import type { LateralGmailCheckpoint } from "../src/types/lateral-gmail-checkpoint";
import { isAfterLateralGmailCheckpoint } from "../src/services/lateral-processing/lateral-gmail-checkpoint-store";

const execFileAsync = promisify(execFile);

async function loadEnvLocal() {
  try {
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
  } catch {
    // optional
  }
}

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function emptyCheckpoint(
  overrides: Partial<LateralGmailCheckpoint> = {}
): LateralGmailCheckpoint {
  return {
    version: 1,
    messageId: null,
    attachmentId: null,
    receivedAt: null,
    receivedAtMs: null,
    attachmentFilename: null,
    driveFileId: null,
    processedAt: null,
    processingResult: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockAttachment(
  partial: Partial<RawGmailAttachment> & {
    attachmentName: string;
    attachmentId: string;
  }
): RawGmailAttachment {
  return {
    datasetName: "Lateral",
    messageId: partial.messageId ?? "msg-1",
    threadId: "thread-1",
    subject: partial.subject ?? "Adhoc DS",
    sender: partial.sender ?? "vendor@example.com",
    receivedAtMs: partial.receivedAtMs ?? 1_000,
    receivedAt: partial.receivedAt ?? "2026-08-25T10:00:00.000Z",
    attachmentId: partial.attachmentId,
    attachmentName: partial.attachmentName,
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 100,
    matchedKeyword: partial.matchedKeyword ?? {
      keyword: "Adhoc DS",
      matchMode: "contains",
      matchedIn: "subject",
      priority: 1,
    },
  };
}

async function writeAtciWorkbook(options: {
  headers: string[];
  rows: string[][];
  sheetName?: string;
  filename?: string;
}): Promise<string> {
  const outPath = path.join(
    os.tmpdir(),
    options.filename ??
      `adhoc-3a-${Date.now()}-${Math.random().toString(16).slice(2)}.xlsx`
  );
  const script = `
import json, sys
from openpyxl import Workbook
payload = json.loads(sys.argv[1])
wb = Workbook()
ws = wb.active
ws.title = payload["sheetName"]
ws.append(payload["headers"])
for row in payload["rows"]:
    ws.append(row)
# decoy sheets
wb.create_sheet("Sheet1")
wb.create_sheet("GCC DS")
wb.save(payload["outPath"])
`.trim();
  const scriptPath = path.join(
    os.tmpdir(),
    `write-3a-${Date.now()}.py`
  );
  await fs.writeFile(scriptPath, script, "utf8");
  try {
    await execFileAsync(
      "python",
      [
        scriptPath,
        JSON.stringify({
          outPath,
          sheetName: options.sheetName ?? "ATCI DS",
          headers: options.headers,
          rows: options.rows,
        }),
      ],
      { windowsHide: true }
    );
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
  return outPath;
}

async function writeWorkbookWithoutAtci(): Promise<string> {
  const outPath = path.join(
    os.tmpdir(),
    `no-atci-${Date.now()}.xlsx`
  );
  const script = `
from openpyxl import Workbook
import sys
wb = Workbook()
wb.active.title = "GCC DS"
wb.active.append(["Job Requisition ID", "Priority"])
wb.active.append(["X-1", "P1"])
wb.create_sheet("Sheet1")
wb.save(sys.argv[1])
`.trim();
  const scriptPath = path.join(os.tmpdir(), `no-atci-write-${Date.now()}.py`);
  await fs.writeFile(scriptPath, script, "utf8");
  try {
    await execFileAsync("python", [scriptPath, outPath], { windowsHide: true });
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
  return outPath;
}

function makeSyncResult(
  partial: Partial<LateralIncrementalSyncResult> & {
    pendingCheckpointAdvances: LateralPendingCheckpointAdvance[];
  }
): LateralIncrementalSyncResult {
  const cp = emptyCheckpoint();
  return {
    checkpointBefore: cp,
    checkpointAfter: cp,
    query: 'in:inbox "Adhoc DS"',
    gmailKeywords: ["Adhoc DS"],
    syncPurpose: "staging_only",
    scannedMessages: 1,
    matchedAttachments: partial.pendingCheckpointAdvances.length,
    processedCount: partial.pendingCheckpointAdvances.length,
    uploadedCount: partial.pendingCheckpointAdvances.length,
    failedCount: 0,
    stoppedOnFailure: false,
    items: [],
    warnings: [],
    message: "ok",
    lastSourceRead: {
      worksheetName: "ATCI DS",
      rowCount: 2,
      colCount: 9,
      headers: ["Job Requisition ID"],
      workbookFileName: "test.xlsx",
    },
    lastMasterDiscovery: null,
    ...partial,
  };
}

const HEADERS = [
  "Job Requisition ID",
  "Priority",
  "Job Description",
  "Market Map",
  "POC",
  "Skill Categorization",
  "Primary Skills",
  "Job Management Level",
  "Primary Location",
];

async function main() {
  await loadEnvLocal();
  console.log("\n=== Phase 3A — Gmail → staging tests ===\n");

  console.log("1. Gmail keywords (one and multiple)");
  {
    const one: DatasetKeywordConfig[] = [
      { value: "Adhoc DS", enabled: true, priority: 1, matchMode: "contains" },
    ];
    const multi: DatasetKeywordConfig[] = [
      { value: "Adhoc DS", enabled: true, priority: 1, matchMode: "contains" },
      { value: "Lateral DS", enabled: true, priority: 2, matchMode: "contains" },
      { value: "ATCI DS", enabled: true, priority: 3, matchMode: "contains" },
    ];
    const q1 = buildLateralExcelDiscoveryQuery({
      afterMs: 1_700_000_000_000,
      keywords: one,
    });
    const q2 = buildLateralExcelDiscoveryQuery({
      afterMs: 1_700_000_000_000,
      keywords: multi,
    });
    ok("1a. single keyword in query", /Adhoc DS/i.test(q1));
    ok(
      "1b. multiple keywords in query",
      /Adhoc DS/i.test(q2) &&
        /Lateral DS/i.test(q2) &&
        /ATCI DS/i.test(q2)
    );
    ok(
      "1c. keyword clause OR-combines",
      (buildLateralKeywordSearchClause(multi) ?? "").includes("OR")
    );
    ok("1d. no hardcoded sender", !/from:/i.test(q2));
  }

  console.log("\n2. Different workbook filenames + attachment selection");
  {
    const day1 = "AdhocDS (Lateral Vendors) as on 25th Aug 2026.xlsx";
    const day2 = "AdhocDS (Lateral Vendors) as on 26th Aug 2026.xlsx";
    const selected = selectLateralExcelAttachment([
      mockAttachment({
        attachmentId: "pdf",
        attachmentName: "notes.pdf",
        matchedKeyword: {
          keyword: "Adhoc DS",
          matchMode: "contains",
          matchedIn: "subject",
          priority: 1,
        },
      }),
      mockAttachment({
        attachmentId: "xlsx-day",
        attachmentName: day1,
        matchedKeyword: {
          keyword: "Adhoc DS",
          matchMode: "contains",
          matchedIn: "attachment",
          priority: 1,
        },
      }),
    ]);
    ok("2a. selects Excel not PDF", selected.selected.attachmentId === "xlsx-day");
    ok("2b. preserves day-1 filename", selected.selected.attachmentName === day1);

    const selected2 = selectLateralExcelAttachment([
      mockAttachment({
        attachmentId: "d2",
        attachmentName: day2,
        matchedKeyword: {
          keyword: "Adhoc DS",
          matchMode: "contains",
          matchedIn: "attachment",
          priority: 1,
        },
      }),
    ]);
    ok(
      "2c. different daily filename accepted",
      selected2.selected.attachmentName === day2
    );
  }

  console.log("\n3. Wrong / non-Excel attachment rejected by selector");
  {
    let threw = false;
    try {
      selectLateralExcelAttachment([
        mockAttachment({
          attachmentId: "p",
          attachmentName: "readme.txt",
        }),
      ]);
    } catch {
      threw = true;
    }
    ok("3a. non-Excel only → throws", threw);
  }

  console.log("\n4–10. Workbook / ATCI DS / date / row variants");
  {
    const reordered = await writeAtciWorkbook({
      filename: `AdhocDS-reordered-${Date.now()}.xlsx`,
      headers: [
        "Primary Location",
        "POC",
        "Job Requisition ID",
        "Priority",
        "Job Description",
        "Market Map",
        "Skill Categorization",
        "Primary Skills",
        "Job Management Level",
      ],
      rows: [
        ["Pune", "Alex", "ATCI-3A-R1", "P1", "d", "m", "s", "Java", "11-Analyst"],
        ["BLR", "Sam", "ATCI-3A-R2", "P2", "d", "m", "s", "Python", "10-Senior Analyst"],
      ],
    });
    const moreRows = await writeAtciWorkbook({
      filename: `AdhocDS-more-${Date.now()}.xlsx`,
      headers: HEADERS,
      rows: [
        ["ATCI-3A-M1", "P1", "d", "m", "p", "s", "sk", "11-Analyst", "Pune"],
        ["ATCI-3A-M2", "P1", "d", "m", "p", "s", "sk", "11-Analyst", "Pune"],
        ["ATCI-3A-M3", "P1", "d", "m", "p", "s", "sk", "11-Analyst", "Pune"],
        ["ATCI-3A-M4", "P1", "d", "m", "p", "s", "sk", "11-Analyst", "Pune"],
        [],
        [],
      ],
    });
    const noAtci = await writeWorkbookWithoutAtci();

    const url = process.env.POSTGRES_URL?.trim();
    if (!url) {
      ok("4. POSTGRES_URL", false, "missing");
    } else {
      const sql = postgres(url, {
        max: 1,
        ssl:
          url.includes("localhost") || url.includes("127.0.0.1")
            ? false
            : "require",
      });
      try {
        const masterBefore = Number(
          (
            await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_master`
          )[0].c
        );

        // Seed prior staging so validation-failure leave-unchanged is meaningful
        const seed = await writeAtciWorkbook({
          headers: HEADERS,
          rows: [["ATCI-3A-SEED", "P1", "d", "m", "p", "s", "sk", "11-Analyst", "Pune"]],
        });
        const seedReport = await importAtciDsWorkbookToStaging({
          sql,
          workbookPath: seed,
          processingDateIso: "2026-08-24",
        });
        ok("4a. seed staging", seedReport.status === "success");
        const stagingBeforeFail = Number(
          (
            await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_staging`
          )[0].c
        );

        // Workbook without ATCI DS
        const missingSheet = await importAtciDsWorkbookToStaging({
          sql,
          workbookPath: noAtci,
        });
        ok(
          "6a. workbook without ATCI DS fails",
          missingSheet.status === "failed" || missingSheet.status === "aborted"
        );
        ok(
          "6b. ATCI DS missing leaves staging unchanged",
          Number(
            (
              await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_staging`
            )[0].c
          ) === stagingBeforeFail
        );

        // Reordered columns
        const reorderReport = await importAtciDsWorkbookToStaging({
          sql,
          workbookPath: reordered,
          processingDateIso: "2026-08-25",
        });
        ok(
          "7a. reordered ATCI DS maps",
          reorderReport.status === "success" &&
            reorderReport.rows.validRows === 2
        );

        // Different row count + blank trailing
        const moreReport = await importAtciDsWorkbookToStaging({
          sql,
          workbookPath: moreRows,
          processingDateIso: "2026-08-26",
        });
        ok(
          "8–9a. different row count + blank trailing",
          moreReport.status === "success" &&
            moreReport.rows.validRows === 4 &&
            ((moreReport.rows.skippedEmptyRows ?? 0) >= 2 ||
              (moreReport.rows.ignoredBlankFormattingRows ?? 0) >= 2 ||
              moreReport.rows.totalSourceRows >= 4)
        );

        // Runtime processing date
        const today = getRuntimeProcessingDateIso();
        const dateReport = await importAtciDsWorkbookToStaging({
          sql,
          workbookPath: reordered,
        });
        ok(
          "10a. runtime processing date used",
          dateReport.status === "success" &&
            dateReport.processingDateIso === today
        );

        // Validation failure (duplicates) leaves staging
        const stagingBeforeDup = Number(
          (
            await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_staging`
          )[0].c
        );
        const dupWb = await writeAtciWorkbook({
          headers: HEADERS,
          rows: [
            ["ATCI-DUP", "P1", "d", "m", "p", "s", "sk", "11-Analyst", "Pune"],
            ["ATCI-DUP", "P2", "d", "m", "p", "s", "sk", "11-Analyst", "Pune"],
          ],
        });
        const dupReport = await importAtciDsWorkbookToStaging({
          sql,
          workbookPath: dupWb,
        });
        ok(
          "11a. validation failure (duplicates)",
          dupReport.status === "aborted" || dupReport.status === "failed"
        );
        ok(
          "11b. staging unchanged after validation failure",
          Number(
            (
              await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_staging`
            )[0].c
          ) === stagingBeforeDup
        );

        // Successful replace
        const replaceWb = await writeAtciWorkbook({
          headers: HEADERS,
          rows: [
            ["ATCI-3A-OK1", "P1", "d", "m", "p", "s", "sk", "11-Analyst", "Pune"],
            ["ATCI-3A-OK2", "P1", "d", "m", "p", "s", "sk", "11-Analyst", "Pune"],
            ["ATCI-3A-OK3", "P1", "d", "m", "p", "s", "sk", "11-Analyst", "Pune"],
          ],
        });
        const replaceReport = await importAtciDsWorkbookToStaging({
          sql,
          workbookPath: replaceWb,
          processingDateIso: "2026-08-27",
        });
        ok(
          "13a. successful staging replace",
          replaceReport.status === "success" &&
            replaceReport.database.stagingCountAfter === 3
        );

        const masterAfter = Number(
          (
            await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_master`
          )[0].c
        );
        ok("11c. master untouched through 3A workbook tests", masterBefore === masterAfter);

        await fs.unlink(seed).catch(() => undefined);
        await fs.unlink(dupWb).catch(() => undefined);
        await fs.unlink(replaceWb).catch(() => undefined);
      } finally {
        await sql.end();
      }
    }

    await fs.unlink(reordered).catch(() => undefined);
    await fs.unlink(moreRows).catch(() => undefined);
    await fs.unlink(noAtci).catch(() => undefined);
  }

  console.log("\n12 / 14 / 15. Checkpoint + PostgreSQL failure via job orchestration");
  {
    const url = process.env.POSTGRES_URL?.trim();
    if (!url) {
      ok("12. POSTGRES_URL for job tests", false, "missing");
    } else {
      const sql = postgres(url, {
        max: 1,
        ssl:
          url.includes("localhost") || url.includes("127.0.0.1")
            ? false
            : "require",
      });

      const goodWb = await writeAtciWorkbook({
        filename: `AdhocDS (Lateral Vendors) as on 28th Aug 2026.xlsx`,
        headers: HEADERS,
        rows: [["ATCI-3A-CP1", "P1", "d", "m", "p", "s", "sk", "11-Analyst", "Pune"]],
      });

      try {
        let checkpointStore = emptyCheckpoint({
          messageId: "msg-old",
          attachmentId: "att-old",
          receivedAt: "2026-08-20T10:00:00.000Z",
          receivedAtMs: 1_000,
          attachmentFilename: "old.xlsx",
          driveFileId: "drive-old",
          processingResult: "SUCCESS",
        });
        let advanceCalls = 0;

        const pending: LateralPendingCheckpointAdvance = {
          messageId: "msg-new",
          attachmentId: "att-new",
          receivedAt: "2026-08-28T10:00:00.000Z",
          receivedAtMs: 2_000,
          attachmentFilename: path.basename(goodWb),
          driveFileId: "drive-new",
          localWorkbookPath: goodWb,
          subject: "Adhoc DS 28 Aug",
          sender: "vendor@example.com",
        };

        // 14. Validation failure → checkpoint not advanced
        const badWb = await writeAtciWorkbook({
          headers: HEADERS,
          rows: [
            ["ATCI-3A-BAD", "P1", "d", "m", "p", "s", "sk", "11-Analyst", "Pune"],
            ["ATCI-3A-BAD", "P1", "d", "m", "p", "s", "sk", "11-Analyst", "Pune"],
          ],
        });
        const failReport = await executeLateralGmailStagingJob({
          sql,
          deps: {
            acquire: async () =>
              makeSyncResult({
                pendingCheckpointAdvances: [
                  { ...pending, localWorkbookPath: badWb, attachmentFilename: path.basename(badWb) },
                ],
              }),
            readCheckpoint: async () => checkpointStore,
            advanceCheckpoint: async (input) => {
              advanceCalls += 1;
              checkpointStore = {
                ...checkpointStore,
                messageId: input.messageId,
                attachmentId: input.attachmentId,
                receivedAt: input.receivedAt,
                receivedAtMs: input.receivedAtMs,
                attachmentFilename: input.attachmentFilename,
                driveFileId: input.driveFileId,
                processedAt: new Date().toISOString(),
                processingResult: "SUCCESS",
                updatedAt: new Date().toISOString(),
              };
              return checkpointStore;
            },
          },
        });
        ok("14a. failed processing status", failReport.status === "failed");
        ok("14b. checkpoint not advanced on fail", advanceCalls === 0);
        ok(
          "14c. checkpoint message unchanged",
          failReport.checkpoint.after.messageId === "msg-old"
        );
        await fs.unlink(badWb).catch(() => undefined);

        // 12. PostgreSQL failure rolls back / does not advance checkpoint
        advanceCalls = 0;
        const pgFail2 = await executeLateralGmailStagingJob({
          sql,
          deps: {
            acquire: async () =>
              makeSyncResult({ pendingCheckpointAdvances: [pending] }),
            readCheckpoint: async () => checkpointStore,
            importWorkbook: async () => {
              throw new Error("simulated PostgreSQL staging insertion failure");
            },
            advanceCheckpoint: async (input) => {
              advanceCalls += 1;
              checkpointStore = {
                ...checkpointStore,
                messageId: input.messageId,
                attachmentId: input.attachmentId,
                receivedAt: input.receivedAt,
                receivedAtMs: input.receivedAtMs,
                attachmentFilename: input.attachmentFilename,
                driveFileId: input.driveFileId,
                processedAt: new Date().toISOString(),
                processingResult: "SUCCESS",
                updatedAt: new Date().toISOString(),
              };
              return checkpointStore;
            },
          },
        });
        ok("12a. DB failure surfaces as failed", pgFail2.status === "failed");
        ok("12b. checkpoint not advanced on DB failure", advanceCalls === 0);
        ok(
          "12c. failure stage staging_database",
          pgFail2.failureStage === "staging_database"
        );

        // 15. Success advances checkpoint
        advanceCalls = 0;
        const beforeMsg = checkpointStore.messageId;
        const okReport = await executeLateralGmailStagingJob({
          sql,
          deps: {
            acquire: async () =>
              makeSyncResult({ pendingCheckpointAdvances: [pending] }),
            readCheckpoint: async () => checkpointStore,
            advanceCheckpoint: async (input) => {
              advanceCalls += 1;
              checkpointStore = {
                version: 1,
                messageId: input.messageId,
                attachmentId: input.attachmentId,
                receivedAt: input.receivedAt,
                receivedAtMs: input.receivedAtMs,
                attachmentFilename: input.attachmentFilename,
                driveFileId: input.driveFileId,
                processedAt: new Date().toISOString(),
                processingResult: "SUCCESS",
                updatedAt: new Date().toISOString(),
              };
              return checkpointStore;
            },
          },
        });
        ok("15a. success status", okReport.status === "success");
        ok("15b. checkpoint advanced once", advanceCalls === 1);
        ok(
          "15c. checkpoint points at new message",
          okReport.checkpoint.after.messageId === "msg-new" &&
            beforeMsg === "msg-old"
        );
        ok(
          "15d. new cursor is after old (existing semantics)",
          isAfterLateralGmailCheckpoint(
            {
              messageId: "msg-new",
              attachmentId: "att-new",
              receivedAtMs: 2_000,
            },
            emptyCheckpoint({
              messageId: "msg-old",
              attachmentId: "att-old",
              receivedAtMs: 1_000,
            })
          )
        );

        // Acquire hard failure → no advance
        advanceCalls = 0;
        checkpointStore = emptyCheckpoint({
          messageId: "msg-old",
          attachmentId: "att-old",
          receivedAtMs: 1_000,
          receivedAt: "2026-08-20T10:00:00.000Z",
          attachmentFilename: "old.xlsx",
          driveFileId: "drive-old",
          processingResult: "SUCCESS",
        });
        const acquireFail = await executeLateralGmailStagingJob({
          sql,
          deps: {
            acquire: async () => {
              throw new Error("Gmail API unavailable");
            },
            readCheckpoint: async () => checkpointStore,
            advanceCheckpoint: async () => {
              advanceCalls += 1;
              return checkpointStore;
            },
          },
        });
        ok("14d. gmail search failure stage", acquireFail.failureStage === "gmail_search");
        ok("14e. no checkpoint on gmail failure", advanceCalls === 0);

        // Idle: no matching email
        const idle = await executeLateralGmailStagingJob({
          sql,
          deps: {
            acquire: async () =>
              makeSyncResult({
                pendingCheckpointAdvances: [],
                uploadedCount: 0,
                matchedAttachments: 0,
                message: "No new Lateral Excel emails after checkpoint.",
              }),
            readCheckpoint: async () => checkpointStore,
            advanceCheckpoint: async () => {
              advanceCalls += 1;
              return checkpointStore;
            },
          },
        });
        ok("5a. no matching email → idle", idle.status === "idle");
        ok("5b. idle does not advance checkpoint", !idle.checkpoint.advanced);

        ok(
          "P. keywords surfaced in report",
          okReport.gmailKeywords.includes("Adhoc DS")
        );
      } finally {
        await sql.end();
        await fs.unlink(goodWb).catch(() => undefined);
      }
    }
  }

  console.log(`\n=== Phase 3A results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
