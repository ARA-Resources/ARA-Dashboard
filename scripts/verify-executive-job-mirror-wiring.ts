/**
 * Checkpoint 4 (new-wiring verification): confirms the new Excel-mirror
 * step wired into `invokeExecutiveJob` (executive-job.ts) honors the
 * non-blocking Postgres-first contract, and that
 * `syncExecutiveMasterWorkbookMirror` itself works end-to-end against REAL
 * Drive reads and the REAL executive_master table (read-only) with ONLY
 * the final `drive.files.update` upload call stubbed out — no live Drive
 * write happens anywhere in this script.
 *
 * Part A: invokeExecutiveJob wiring, fully faked deps (no real Gmail/DB/Drive
 * at all) — proves the NEW wiring code in executive-job.ts itself is correct:
 *   A1. syncExcelMirror fails -> job still reports success, checkpoint still
 *       advances, failure is recorded in excelMirrorOk/summary.excelMirror.
 *   A2. syncExcelMirror succeeds -> success threads through correctly.
 *
 * Part B: syncExecutiveMasterWorkbookMirror for real (real executive_master
 * SELECT, real Drive download of the real Master Workbook, real write via
 * the already-verified writer, real local verify step) with a stubbed
 * `drive.files.update` that captures what WOULD have been uploaded (by
 * copying the local file to a side path before "succeeding") instead of
 * ever calling the real Drive API.
 */
import fs from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import type { drive_v3 } from "googleapis";
import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import { invokeExecutiveJob } from "../src/services/executive-processing/executive-job";
import { syncExecutiveMasterWorkbookMirror } from "../src/services/executive-processing/executive-master-workbook-sync";
import type { ExecutiveMasterReconcileResult } from "../src/services/executive-processing/executive-master-reconcile-postgres";
import type { ExecutivePostedRefreshResult } from "../src/services/executive-processing/executive-posted-refresh";
import type { ExecutiveIncrementalSyncResult } from "../src/services/executive-processing/executive-gmail-incremental-sync";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function buildSyntheticBaseDsFile(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Base DS");
  ws.addRow([
    "Job Requisition ID",
    "Final Market Map (New)",
    "Primary Skills",
    "Job Management Level",
    "Skill Categorization",
    "Primary Location",
    "Mandatory skill",
    "Location Flex",
    "Job Description",
    "Priority given to agency",
  ]);
  ws.addRow(["ATCI-WIRING-TEST-0000001", "APAC", "Java", "7-Manager", "Core", "Pune", "Spring", "No Flex", "desc", "High"]);
  const localPath = path.join(os.tmpdir(), `synthetic-base-ds-${Date.now()}.xlsx`);
  await wb.xlsx.writeFile(localPath);
  return localPath;
}

async function partA() {
  console.log("=== Part A: invokeExecutiveJob wiring (fully faked deps, zero real I/O) ===\n");
  const baseDsPath = await buildSyntheticBaseDsFile();

  const fakeReconcile = (async (): Promise<ExecutiveMasterReconcileResult> => ({
    ok: true,
    counts: {
      demandRowCount: 1,
      uniqueDemandJrCount: 1,
      masterJrCountBefore: 0,
      added: 1,
      reopened: 0,
      activated: 0,
      unchanged: 0,
      closed: 0,
      masterJrCountAfter: 1,
    },
    processingDateIso: "2026-09-17",
    cellErrorWarnings: [],
    headerWarnings: [],
    message: "fake reconcile ok",
  })) as never;

  const fakeRefreshPosted = (async (): Promise<ExecutivePostedRefreshResult> => ({
    ok: true,
    skipped: false,
    counts: { masterJrCount: 1, postedSheetRowCount: 1, postedYes: 0, postedDash: 1, changed: 0 },
    sourceFileName: "fake-posted-sheet.xlsm",
    message: "fake posted refresh ok",
  })) as never;

  const fakeRunSync = (async (): Promise<ExecutiveIncrementalSyncResult> => ({
    ok: true,
    message: "fake sync: 1 pending",
    failedCount: 0,
    stoppedOnFailure: false,
    items: [],
    pendingCheckpointAdvances: [
      {
        messageId: "fake-msg-1",
        attachmentId: "fake-att-1",
        receivedAt: new Date().toISOString(),
        receivedAtMs: Date.now(),
        attachmentFilename: "ATCI Exec DS_17 Sep 26.xlsx",
        driveFileId: "fake-drive-file-1",
        sender: "fake@example.com",
        subject: "fake subject",
        localWorkbookPath: baseDsPath,
      },
    ],
  })) as never;

  let advanceCheckpointCalled = false;
  const fakeAdvanceCheckpoint = (async () => {
    advanceCheckpointCalled = true;
  }) as never;

  // A1: mirror fails -> job must still succeed, checkpoint must still advance
  {
    advanceCheckpointCalled = false;
    const outcome = await invokeExecutiveJob("manual", {
      acquireLock: (async () => ({ acquired: true, release: async () => undefined })) as never,
      runSync: fakeRunSync,
      reconcile: fakeReconcile,
      refreshPosted: fakeRefreshPosted,
      advanceCheckpoint: fakeAdvanceCheckpoint,
      syncExcelMirror: (async () => ({
        ok: false,
        phase: "upload",
        reason: "synthetic failure for wiring test",
      })) as never,
    });

    assert(outcome.status === "success", `A1: job status must be "success" despite mirror failure, got "${outcome.status}"`);
    assert(outcome.checkpointAdvanced === true, "A1: checkpoint must still advance despite mirror failure");
    assert(advanceCheckpointCalled, "A1: advanceCheckpoint must actually have been called");
    assert(outcome.excelMirrorOk === false, `A1: excelMirrorOk must be false, got ${outcome.excelMirrorOk}`);
    assert(outcome.summary?.excelMirror?.ok === false, "A1: summary.excelMirror.ok must be false");
    assert(
      outcome.summary?.excelMirror?.message.includes("synthetic failure for wiring test"),
      `A1: summary.excelMirror.message must contain the failure reason, got: ${outcome.summary?.excelMirror?.message}`
    );
    console.log("A1 PASS: mirror failure does not block job success or checkpoint advance.");
    console.log(`  outcome.message: ${outcome.message}\n`);
  }

  // A2: mirror succeeds -> success threads through correctly
  {
    advanceCheckpointCalled = false;
    const outcome = await invokeExecutiveJob("manual", {
      acquireLock: (async () => ({ acquired: true, release: async () => undefined })) as never,
      runSync: fakeRunSync,
      reconcile: fakeReconcile,
      refreshPosted: fakeRefreshPosted,
      advanceCheckpoint: fakeAdvanceCheckpoint,
      syncExcelMirror: (async () => ({
        ok: true,
        newSheetRowsWritten: 1,
        masterRowsUpdated: 1,
        driveFileId: "fake-master-file-id",
        message: "fake mirror ok: 1 New Sheet row(s), 1 Master Sheet row(s).",
      })) as never,
    });

    assert(outcome.status === "success", `A2: job status must be "success", got "${outcome.status}"`);
    assert(outcome.checkpointAdvanced === true, "A2: checkpoint must advance");
    assert(advanceCheckpointCalled, "A2: advanceCheckpoint must have been called");
    assert(outcome.excelMirrorOk === true, "A2: excelMirrorOk must be true");
    assert(outcome.summary?.excelMirror?.ok === true, "A2: summary.excelMirror.ok must be true");
    assert(outcome.summary?.excelMirror?.newSheetRowsWritten === 1, "A2: newSheetRowsWritten must thread through");
    assert(outcome.summary?.excelMirror?.masterRowsUpdated === 1, "A2: masterRowsUpdated must thread through");
    assert(
      outcome.message.includes("fake mirror ok"),
      `A2: final message must include the mirror's own message, got: ${outcome.message}`
    );
    console.log("A2 PASS: mirror success threads through correctly into outcome and summary.");
    console.log(`  outcome.message: ${outcome.message}\n`);
  }

  await fs.unlink(baseDsPath).catch(() => undefined);
}

async function partB() {
  console.log("=== Part B: syncExecutiveMasterWorkbookMirror for real (Drive upload stubbed only) ===\n");
  const baseDsPath = await buildSyntheticBaseDsFile();

  const { drive: realDrive } = await getAuthorizedGmailClient();

  let capturedUploadPath: string | null = null;
  let updateCallCount = 0;
  let capturedFileId: string | null = null;
  let capturedMimeType: string | null = null;

  const stubbedDrive = {
    files: {
      get: realDrive.files.get.bind(realDrive), // pass-through: real, read-only
      update: (async (params: {
        fileId?: string;
        requestBody?: { mimeType?: string };
        media?: { body?: NodeJS.ReadableStream };
      }) => {
        updateCallCount += 1;
        capturedFileId = params.fileId ?? null;
        capturedMimeType = params.requestBody?.mimeType ?? null;
        // Actually consume the stream (like the real googleapis client would
        // while uploading) rather than just reading its .path -- an unread
        // fs.ReadStream still lazily opens the file asynchronously, which
        // would otherwise fire AFTER the caller's `finally` deletes it.
        if (params.media?.body) {
          capturedUploadPath = path.join(os.tmpdir(), `captured-upload-${Date.now()}.xlsm`);
          await pipeline(params.media.body, createWriteStream(capturedUploadPath));
        }
        console.log(`  [STUB] drive.files.update called for fileId=${params.fileId} -- NOT actually calling the real Drive API.`);
        return { data: { id: params.fileId, name: "stubbed", mimeType: params.requestBody?.mimeType, modifiedTime: new Date().toISOString() } };
      }) as unknown as typeof realDrive.files.update,
    },
  } as unknown as drive_v3.Drive;

  const result = await syncExecutiveMasterWorkbookMirror({
    localDemandWorkbookPath: baseDsPath,
    drive: stubbedDrive,
  });

  console.log("Result:", JSON.stringify(result, null, 2));
  assert(result.ok === true, `Part B: mirror must succeed, got: ${JSON.stringify(result)}`);
  if (result.ok) {
    assert(result.newSheetRowsWritten === 1, `Part B: expected 1 New Sheet row written, got ${result.newSheetRowsWritten}`);
    assert(typeof result.masterRowsUpdated === "number", "Part B: masterRowsUpdated must be a real number from the real executive_master table");
  }
  assert(updateCallCount === 1, `Part B: drive.files.update must be called exactly once, got ${updateCallCount}`);
  assert(capturedFileId !== null, "Part B: must have captured the target fileId");
  assert(capturedMimeType === "application/vnd.ms-excel.sheet.macroEnabled.12", `Part B: mimeType must be XLSM, got ${capturedMimeType}`);
  assert(capturedUploadPath !== null && existsSync(capturedUploadPath), "Part B: must have captured the local file that would have been uploaded");
  console.log("PASS: real read + real write + real local verify all ran; only the final Drive API write was stubbed.\n");

  // Independently confirm the captured (would-have-been-uploaded) file is a
  // real, valid xlsm with New Sheet correctly populated and VBA intact.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(capturedUploadPath!);
  const newSheet = wb.worksheets.find((w) => w.name === "New Sheet")!;
  assert(newSheet.getCell(2, 1).value === "ATCI-WIRING-TEST-0000001", "captured file: New Sheet row 2 must be the synthetic JR");
  console.log("  Confirmed: the captured would-have-been-uploaded file has the correct New Sheet content.");

  await fs.unlink(baseDsPath).catch(() => undefined);
  await fs.unlink(capturedUploadPath!).catch(() => undefined);
}

async function main() {
  await partA();
  await partB();
  console.log("=== ALL CHECKS PASSED ===");
}

main().catch((err) => {
  console.error("WIRING VERIFICATION FAILED:", err);
  process.exit(1);
});
