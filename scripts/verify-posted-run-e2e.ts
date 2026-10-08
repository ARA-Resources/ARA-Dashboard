/**
 * Part A end-to-end test: the full Lateral/Executive Posted run services
 * against a REAL throwaway Postgres (synthetic rows only) and a fake Drive
 * (scripts/fixtures/posted-fake-drive.ts — never importable from src/).
 * Requires POSTGRES_URL pointed at a throwaway Postgres with migrations
 * 001-025 applied, and ARA_POSTED_FAKE_DRIVE=1.
 */
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDbClient } from "../src/lib/persistence/db-client";
import { PostgresSchedulerStateStore } from "../src/lib/persistence/postgres-stores";
import { runLateralPostedButton, readLateralPostedSummary } from "../src/services/lateral-processing/lateral-posted-run";
import { runExecutivePostedButton, readExecutivePostedSummary } from "../src/services/executive-processing/executive-posted-run";
import { readPostedSheetTabRaw } from "../src/services/dataset-posted/posted-sheet-reader";
import { createFakeDrive } from "./fixtures/posted-fake-drive";

const execFileAsync = promisify(execFile);

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Published, stable constants — src/lib/persistence/job-lock.ts (not exported, hardcoded here by value).
const LATERAL_LOCK_KEY = 7482910234;
const EXECUTIVE_LOCK_KEY = 7482910249;

function enableWrites(on: boolean) {
  if (on) process.env.ARA_POSTED_WRITES_ENABLED = "1";
  else delete process.env.ARA_POSTED_WRITES_ENABLED;
}

async function buildFixture(kind: "normal" | "empty"): Promise<string> {
  const outPath = path.join(os.tmpdir(), `posted-e2e-${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
  const builder = kind === "normal" ? "build-posted-sheet-fixture.py" : "build-posted-sheet-fixture-empty.py";
  await execFileAsync("python3", [path.join(__dirname, "fixtures", builder), outPath]);
  return outPath;
}

async function resetLateralMaster() {
  const sql = getDbClient();
  await sql`DELETE FROM lateral_master`;
  await sql`INSERT INTO lateral_master (job_requisition_id, posted) VALUES ('ATCI-7001-S1', '-'), ('ATCI-9999-S9', 'Yes')`;
}
async function resetExecutiveMaster() {
  const sql = getDbClient();
  await sql`DELETE FROM executive_master`;
  await sql`INSERT INTO executive_master (job_requisition_id, posted) VALUES ('ATCI-7001-S1', '-'), ('ATCI-9999-S9', 'Yes')`;
}
async function resetPostedSummaries() {
  const sql = getDbClient();
  await sql`UPDATE lateral_scheduler_state SET last_posted_summary = NULL`;
  await sql`UPDATE executive_scheduler_state SET last_posted_summary = NULL`;
}
async function seedDropRows(table: "lateral_master" | "executive_master", prefix: string, count: number) {
  const sql = getDbClient();
  for (let i = 1; i <= count; i++) {
    const id = `${prefix}${i}`;
    if (table === "lateral_master") await sql`INSERT INTO lateral_master (job_requisition_id, posted) VALUES (${id}, 'Yes')`;
    else await sql`INSERT INTO executive_master (job_requisition_id, posted) VALUES (${id}, 'Yes')`;
  }
}
async function cleanupDropRows(table: "lateral_master" | "executive_master", prefix: string) {
  const sql = getDbClient();
  if (table === "lateral_master") await sql`DELETE FROM lateral_master WHERE job_requisition_id LIKE ${prefix + "%"}`;
  else await sql`DELETE FROM executive_master WHERE job_requisition_id LIKE ${prefix + "%"}`;
}
async function currentYesCount(table: "lateral_master" | "executive_master"): Promise<number> {
  const sql = getDbClient();
  const rows =
    table === "lateral_master"
      ? await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM lateral_master WHERE posted = 'Yes'`
      : await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM executive_master WHERE posted = 'Yes'`;
  return rows[0]?.count ?? 0;
}
async function postedValue(table: "lateral_master" | "executive_master", jr: string): Promise<string | null> {
  const sql = getDbClient();
  const rows =
    table === "lateral_master"
      ? await sql<{ posted: string | null }[]>`SELECT posted FROM lateral_master WHERE job_requisition_id = ${jr}`
      : await sql<{ posted: string | null }[]>`SELECT posted FROM executive_master WHERE job_requisition_id = ${jr}`;
  return rows[0]?.posted ?? null;
}

type PostedRunResult =
  | { ok: true; busy: false; previewOnly: boolean; counts: unknown; wouldSkipDriveUpload: boolean; message: string }
  | { ok: false; busy: true; message: string }
  | { ok: false; busy: false; refused: true; message: string }
  | { ok: false; busy: false; refused: false; driveWarning: boolean; message: string };

interface DatasetRunner {
  name: string;
  masterTable: "lateral_master" | "executive_master";
  resetMaster: () => Promise<void>;
  columnCYes: string;
  columnCNo: string;
  lockKey: number;
  run: (opts: { force?: boolean; testHooks: unknown }) => Promise<PostedRunResult>;
  readSummary: () => Promise<unknown>;
  buildHooks: (drive: unknown, fileId: string, fileName: string) => unknown;
}

const LATERAL: DatasetRunner = {
  name: "Lateral",
  masterTable: "lateral_master",
  resetMaster: resetLateralMaster,
  columnCYes: "Yes",
  columnCNo: "No",
  lockKey: LATERAL_LOCK_KEY,
  run: (opts) => runLateralPostedButton(opts as never),
  readSummary: readLateralPostedSummary,
  buildHooks: (drive, fileId, fileName) => ({ drive, fileId, fileName, masterSheet: "Master Sheet", postedSheet: "Posted Sheet" }),
};

const EXECUTIVE: DatasetRunner = {
  name: "Executive",
  masterTable: "executive_master",
  resetMaster: resetExecutiveMaster,
  columnCYes: "Yes",
  columnCNo: "-",
  lockKey: EXECUTIVE_LOCK_KEY,
  run: (opts) => runExecutivePostedButton(opts as never),
  readSummary: readExecutivePostedSummary,
  buildHooks: (drive, fileId) => ({ drive, fileId }),
};

async function runScenarios(ds: DatasetRunner) {
  console.log(`\n=== ${ds.name} ===`);

  // --- A: writes OFF -> preview, zero changes ---
  {
    enableWrites(false);
    await ds.resetMaster();
    await resetPostedSummaries();
    const fixture = await buildFixture("normal");
    const drive = await createFakeDrive({ folder: path.join(os.tmpdir(), `fake-drive-${ds.name}-A-${Date.now()}`), fileId: "fake-file", fileName: "fake.xlsm", seedLocalXlsmPath: fixture });
    const before = await drive.readCurrentBytes();
    const result = await ds.run({ testHooks: ds.buildHooks(drive.drive, "fake-file", "fake.xlsm") });
    assert(result.ok === true && result.previewOnly === true, `[A] expected preview result, got ${JSON.stringify(result)}`);
    assert(result.message.startsWith("Preview only, writes are off"), `[A] message must start with the preview phrase, got "${result.message}"`);
    const after = await drive.readCurrentBytes();
    assert(Buffer.compare(before, after) === 0, "[A] fake Drive bytes must be completely unchanged in preview mode");
    assert((await postedValue(ds.masterTable, "ATCI-7001-S1")) === "-", "[A] Postgres must be completely unchanged in preview mode");
    assert((await ds.readSummary()) === null, "[A] last_posted_summary must NOT be written in preview mode");
    console.log("[A] writes OFF: preview, zero Postgres/Drive changes, no summary written — OK");
  }

  // --- B: writes ON, normal case ---
  {
    enableWrites(true);
    await ds.resetMaster();
    await resetPostedSummaries();
    const fixture = await buildFixture("normal");
    const drive = await createFakeDrive({ folder: path.join(os.tmpdir(), `fake-drive-${ds.name}-B-${Date.now()}`), fileId: "fake-file", fileName: "fake.xlsm", seedLocalXlsmPath: fixture });
    const result = await ds.run({ testHooks: ds.buildHooks(drive.drive, "fake-file", "fake.xlsm") });
    assert(result.ok === true && result.previewOnly === false, `[B] expected a real success result, got ${JSON.stringify(result)}`);
    assert((await postedValue(ds.masterTable, "ATCI-7001-S1")) === "Yes", "[B] matched JR must become Yes in Postgres");
    assert((await postedValue(ds.masterTable, "ATCI-9999-S9")) === "-", "[B] previously-Yes, now-absent JR must reset to '-' (full refresh)");
    const summary = await ds.readSummary();
    assert(summary !== null, "[B] last_posted_summary must be written");

    const tmpCheckPath = path.join(os.tmpdir(), `posted-e2e-readback-${ds.name}-${Date.now()}.xlsx`);
    const fsPromises = await import("node:fs/promises");
    await fsPromises.writeFile(tmpCheckPath, await drive.readCurrentBytes());
    const raw = await readPostedSheetTabRaw(tmpCheckPath, "Posted Sheet");
    assert(raw.ok, "[B] re-reading the uploaded fake-Drive bytes must succeed");
    if (raw.ok) {
      assert(raw.rows.length === 2, `[B] expected 2 surviving rows, got ${raw.rows.length}`);
      const row1 = raw.rows.find((r) => r.columnB === "ATCI-7001-S1");
      assert(!!row1 && row1.columnC === ds.columnCYes, `[B] matched row's Column C must be "${ds.columnCYes}", got ${JSON.stringify(row1)}`);
      const row2 = raw.rows.find((r) => r.columnB === "ATCI-7002-S1");
      assert(!!row2 && row2.columnC === ds.columnCNo, `[B] unmatched row's Column C must be "${ds.columnCNo}", got ${JSON.stringify(row2)}`);
    }
    if (ds === LATERAL) {
      const inspectScript = `
import json, sys
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1])
m = wb["Master Sheet"]
print(json.dumps({"b2": m["B2"].value}))
`.trim();
      const scriptPath = path.join(os.tmpdir(), `posted-e2e-inspect-${Date.now()}.py`);
      await fsPromises.writeFile(scriptPath, inspectScript, "utf8");
      const { stdout } = await execFileAsync("python3", [scriptPath, tmpCheckPath]);
      const parsed = JSON.parse(stdout.trim());
      assert(parsed.b2 === "Yes", `[B] Lateral Master Sheet column M (B2 in fixture) must become "Yes", got "${parsed.b2}"`);
      await fsPromises.unlink(scriptPath).catch(() => undefined);
    }
    await fsPromises.unlink(tmpCheckPath).catch(() => undefined);
    console.log("[B] writes ON, normal case: Postgres and tab both correct — OK");
  }

  // --- C: Drive upload fails after Postgres succeeded ---
  {
    enableWrites(true);
    await ds.resetMaster();
    await resetPostedSummaries();
    const fixture = await buildFixture("normal");
    const drive = await createFakeDrive({ folder: path.join(os.tmpdir(), `fake-drive-${ds.name}-C-${Date.now()}`), fileId: "fake-file", fileName: "fake.xlsm", seedLocalXlsmPath: fixture });
    const beforeBytes = await drive.readCurrentBytes();
    drive.failNextUpload("simulated 503"); // original attempt
    drive.failNextUpload("simulated 503"); // the retry wrapper's one retry must also fail, to test a permanent failure
    const result = await ds.run({ testHooks: ds.buildHooks(drive.drive, "fake-file", "fake.xlsm") });
    assert(!result.ok && !result.busy && !result.refused && result.driveWarning === true, `[C] expected the orange Drive warning, got ${JSON.stringify(result)}`);
    assert(result.message.startsWith("Dashboard updated, Drive sheet NOT updated, click again"), `[C] message must be the exact orange-warning text, got "${result.message}"`);
    assert((await postedValue(ds.masterTable, "ATCI-7001-S1")) === "Yes", "[C] Postgres must still be updated");
    const afterBytes = await drive.readCurrentBytes();
    assert(Buffer.compare(beforeBytes, afterBytes) === 0, "[C] fake Drive bytes must be completely unchanged — nothing half-written");
    console.log("[C] Drive upload fails after Postgres succeeded: orange warning, Postgres updated, Drive untouched — OK");
  }

  // --- D: Drive download fails ---
  {
    enableWrites(true);
    await ds.resetMaster();
    await resetPostedSummaries();
    const fixture = await buildFixture("normal");
    const drive = await createFakeDrive({ folder: path.join(os.tmpdir(), `fake-drive-${ds.name}-D-${Date.now()}`), fileId: "fake-file", fileName: "fake.xlsm", seedLocalXlsmPath: fixture });
    drive.failNextDownload("simulated 503");
    drive.failNextDownload("simulated 503"); // one retry is also allowed to fail
    const result = await ds.run({ testHooks: ds.buildHooks(drive.drive, "fake-file", "fake.xlsm") });
    assert(!result.ok && !result.busy && !result.refused && result.driveWarning === false, `[D] expected a plain failure, got ${JSON.stringify(result)}`);
    assert(result.message.endsWith("Nothing was changed."), `[D] message must end with "Nothing was changed.", got "${result.message}"`);
    assert((await postedValue(ds.masterTable, "ATCI-7001-S1")) === "-", "[D] Postgres must NOT be written when the download fails");
    console.log('[D] Drive download fails (both attempts): "Nothing was changed.", no Postgres write — OK');
  }

  // --- E: modifiedTime changes between download and upload ---
  {
    enableWrites(true);
    await ds.resetMaster();
    await resetPostedSummaries();
    const fixture = await buildFixture("normal");
    const drive = await createFakeDrive({ folder: path.join(os.tmpdir(), `fake-drive-${ds.name}-E-${Date.now()}`), fileId: "fake-file", fileName: "fake.xlsm", seedLocalXlsmPath: fixture });
    const beforeBytes = await drive.readCurrentBytes();
    // Simulate "someone else edited it" the instant after our download: touch now,
    // before calling run() — the run's own download happens first and captures the
    // ORIGINAL modifiedTime; our touch here changes it before the run's later
    // re-check (right before upload) — so the re-check must see a mismatch.
    const originalRun = ds.run;
    let touched = false;
    type MockDriveFilesGet = (params: { fileId?: string; alt?: string }, config?: unknown) => Promise<unknown>;
    const mockFiles = drive.drive.files as unknown as { get: MockDriveFilesGet };
    const wrappedRun: DatasetRunner["run"] = async (opts) => {
      // Patch the fake drive's get() to touch on the SECOND metadata call (the recheck).
      const originalGet = mockFiles.get.bind(drive.drive.files);
      let metaCalls = 0;
      mockFiles.get = async (params, config) => {
        if (!params.alt) {
          metaCalls += 1;
          if (metaCalls === 2 && !touched) {
            touched = true;
            drive.touchExternally();
          }
        }
        return originalGet(params, config);
      };
      return originalRun(opts);
    };
    const result = await wrappedRun({ testHooks: ds.buildHooks(drive.drive, "fake-file", "fake.xlsm") });
    assert(!result.ok && !result.busy && !result.refused && result.driveWarning === true, `[E] expected the orange Drive warning (abort, not retry), got ${JSON.stringify(result)}`);
    assert(result.message.includes("Someone else edited the workbook"), `[E] message must explain the race, got "${result.message}"`);
    const afterBytes = await drive.readCurrentBytes();
    assert(Buffer.compare(beforeBytes, afterBytes) === 0, "[E] fake Drive bytes must be completely unchanged — zero Drive writes on a modifiedTime mismatch");
    console.log("[E] modifiedTime changes mid-run: abort, zero Drive writes, no retry — OK");
  }

  // --- F: zero JR IDs -> refuse, force cannot override ---
  {
    enableWrites(true);
    await ds.resetMaster();
    await resetPostedSummaries();
    const fixture = await buildFixture("empty");
    const drive = await createFakeDrive({ folder: path.join(os.tmpdir(), `fake-drive-${ds.name}-F-${Date.now()}`), fileId: "fake-file", fileName: "fake.xlsm", seedLocalXlsmPath: fixture });
    const result1 = await ds.run({ testHooks: ds.buildHooks(drive.drive, "fake-file", "fake.xlsm") });
    assert(!result1.ok && !result1.busy && result1.refused === true, `[F] expected a refusal, got ${JSON.stringify(result1)}`);
    assert(result1.message.includes("zero JR IDs"), `[F] message must mention zero JR IDs, got "${result1.message}"`);
    const result2 = await ds.run({ force: true, testHooks: ds.buildHooks(drive.drive, "fake-file", "fake.xlsm") });
    assert(!result2.ok && !result2.busy && result2.refused === true, `[F] force=true must NOT override the zero-JR-IDs guard, got ${JSON.stringify(result2)}`);
    console.log("[F] zero JR IDs: refuses, force cannot override — OK");
  }

  // --- G: 35% drop -> refuse with both numbers; force=true goes through ---
  {
    enableWrites(true);
    await ds.resetMaster();
    await resetPostedSummaries();
    const dropPrefix = `ATCI-DROP-${ds.name}-`;
    await seedDropRows(ds.masterTable, dropPrefix, 10); // + the baseline 1 Yes row = 11 current Yes
    try {
      const fixture = await buildFixture("normal"); // only ever yields 1 new Yes (ATCI-7001-S1)
      const drive1 = await createFakeDrive({ folder: path.join(os.tmpdir(), `fake-drive-${ds.name}-G1-${Date.now()}`), fileId: "fake-file", fileName: "fake.xlsm", seedLocalXlsmPath: fixture });
      const current = await currentYesCount(ds.masterTable);
      const result = await ds.run({ testHooks: ds.buildHooks(drive1.drive, "fake-file", "fake.xlsm") });
      assert(!result.ok && !result.busy && result.refused === true, `[G] expected a sharp-drop refusal (current=${current}), got ${JSON.stringify(result)}`);
      assert(result.message.includes("more than 35% below"), `[G] message must explain the drop, got "${result.message}"`);

      const fixture2 = await buildFixture("normal");
      const drive2 = await createFakeDrive({ folder: path.join(os.tmpdir(), `fake-drive-${ds.name}-G2-${Date.now()}`), fileId: "fake-file", fileName: "fake.xlsm", seedLocalXlsmPath: fixture2 });
      const resultForced = await ds.run({ force: true, testHooks: ds.buildHooks(drive2.drive, "fake-file", "fake.xlsm") });
      assert(resultForced.ok === true, `[G] force=true must proceed past the sharp-drop guard, got ${JSON.stringify(resultForced)}`);
      console.log("[G] 35% drop: refuses with both numbers; force=true proceeds — OK");
    } finally {
      await cleanupDropRows(ds.masterTable, dropPrefix);
    }
  }

  // --- H: already-clean tab -> Drive upload skipped ---
  {
    enableWrites(true);
    await ds.resetMaster();
    await resetPostedSummaries();
    // Build a fixture, run once to make it canonical, THEN test the second run sees it as already-clean.
    const fixture = await buildFixture("normal");
    const drive = await createFakeDrive({ folder: path.join(os.tmpdir(), `fake-drive-${ds.name}-H-${Date.now()}`), fileId: "fake-file", fileName: "fake.xlsm", seedLocalXlsmPath: fixture });
    await ds.run({ testHooks: ds.buildHooks(drive.drive, "fake-file", "fake.xlsm") }); // first run cleans it
    const bytesAfterFirst = await drive.readCurrentBytes();
    const result = await ds.run({ testHooks: ds.buildHooks(drive.drive, "fake-file", "fake.xlsm") }); // second run: nothing left to clean
    assert(result.ok === true && result.wouldSkipDriveUpload === true, `[H] expected an already-clean no-op, got ${JSON.stringify(result)}`);
    assert(result.message.startsWith("Sheet was already clean, no Drive changes"), `[H] message must say already clean, got "${result.message}"`);
    const bytesAfterSecond = await drive.readCurrentBytes();
    assert(Buffer.compare(bytesAfterFirst, bytesAfterSecond) === 0, "[H] Drive bytes must be byte-identical — no upload happened on the second run");
    console.log("[H] already-clean tab: Drive upload skipped, counts still shown — OK");
  }

  // --- I: second click right after the first -> identical Postgres and tab ---
  {
    enableWrites(true);
    await ds.resetMaster();
    await resetPostedSummaries();
    const fixture = await buildFixture("normal");
    const drive = await createFakeDrive({ folder: path.join(os.tmpdir(), `fake-drive-${ds.name}-I-${Date.now()}`), fileId: "fake-file", fileName: "fake.xlsm", seedLocalXlsmPath: fixture });
    await ds.run({ testHooks: ds.buildHooks(drive.drive, "fake-file", "fake.xlsm") });
    const posted1 = await postedValue(ds.masterTable, "ATCI-7001-S1");
    const bytes1 = await drive.readCurrentBytes();
    await ds.run({ testHooks: ds.buildHooks(drive.drive, "fake-file", "fake.xlsm") });
    const posted2 = await postedValue(ds.masterTable, "ATCI-7001-S1");
    const bytes2 = await drive.readCurrentBytes();
    assert(posted1 === posted2, "[I] Postgres value must be identical on the second click");
    assert(Buffer.compare(bytes1, bytes2) === 0, "[I] Drive bytes must be byte-identical on the second click");
    console.log("[I] second click right after the first: identical Postgres and tab — OK");
  }

  // --- J: lock busy (held from a second raw connection) ---
  {
    enableWrites(true);
    await ds.resetMaster();
    const sql = getDbClient();
    const reserved = await sql.reserve();
    await reserved`SELECT pg_advisory_lock(${ds.lockKey})`;
    try {
      const fixture = await buildFixture("normal");
      const drive = await createFakeDrive({ folder: path.join(os.tmpdir(), `fake-drive-${ds.name}-J-${Date.now()}`), fileId: "fake-file", fileName: "fake.xlsm", seedLocalXlsmPath: fixture });
      const result = await ds.run({ testHooks: ds.buildHooks(drive.drive, "fake-file", "fake.xlsm") });
      assert(!result.ok && result.busy === true, `[J] expected busy=true, got ${JSON.stringify(result)}`);
      // No in-process holder marker exists for a lock held from an external raw
      // connection, so this must fall back to the lock's own generic message
      // (never blank, never a wrong "Run All"/"Posted" attribution it can't back up).
      assert(typeof result.message === "string" && result.message.length > 0, `[J] message must never be blank, got "${result.message}"`);
      assert(!/Run All|Posted run/i.test(result.message), `[J] with no holder marker, the message must NOT falsely attribute the lock to Run All or another Posted run, got "${result.message}"`);
    } finally {
      await reserved`SELECT pg_advisory_unlock(${ds.lockKey})`;
      reserved.release();
    }
    console.log('[J] lock busy from an external connection with no holder marker: generic "A run is in progress." — OK');
  }

  // --- K: last_posted_summary survives a Run-All-style save ---
  {
    enableWrites(true);
    await ds.resetMaster();
    await resetPostedSummaries();
    const fixture = await buildFixture("normal");
    const drive = await createFakeDrive({ folder: path.join(os.tmpdir(), `fake-drive-${ds.name}-K-${Date.now()}`), fileId: "fake-file", fileName: "fake.xlsm", seedLocalXlsmPath: fixture });
    await ds.run({ testHooks: ds.buildHooks(drive.drive, "fake-file", "fake.xlsm") });
    const summaryBefore = await ds.readSummary();
    assert(summaryBefore !== null, "[K] last_posted_summary must exist after a real run");
    if (ds === LATERAL) {
      await new PostgresSchedulerStateStore().writeLateral({ lastTrigger: "manual" });
    } else {
      await new PostgresSchedulerStateStore().writeExecutive({ lastTrigger: "manual" } as never);
    }
    const summaryAfter = await ds.readSummary();
    assert(JSON.stringify(summaryBefore) === JSON.stringify(summaryAfter), "[K] a Run-All-style save must NOT erase or change last_posted_summary");
    console.log("[K] last_posted_summary survives a Run-All-style scheduler-state save — OK");
  }

  enableWrites(false);
  await ds.resetMaster();
  await resetPostedSummaries();
}

async function main() {
  await runScenarios(LATERAL);
  await runScenarios(EXECUTIVE);
  console.log("\nverify-posted-run-e2e: OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
