/**
 * Part A, item 3: run the REAL Step 18 code
 * (applyPostedSheetMatchingToStagedWorkbook, lateral-posted-sheet-processor.ts
 * — completely untouched by this feature) on a tab our Posted button already
 * cleaned, and run our Posted button on a tab Step 18 already processed.
 * Compare the Posted Sheet tab and Master Sheet column M cell-by-cell
 * between both directions. Step 18 itself is never edited — this only
 * calls it.
 *
 * Scope note: the fixture used here has no blank/title-line rows (Step 18
 * has no row-deletion concept to compare against), so this isolates the
 * comparison to the matching/column-convention logic the two share.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDbClient } from "../src/lib/persistence/db-client";
import { runLateralPostedButton } from "../src/services/lateral-processing/lateral-posted-run";
import { applyPostedSheetMatchingToStagedWorkbook } from "../src/services/lateral-processing/lateral-posted-sheet-processor";
import { readPostedSheetTabRaw } from "../src/services/dataset-posted/posted-sheet-reader";
import { createFakeDrive } from "./fixtures/posted-fake-drive";

const execFileAsync = promisify(execFile);

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function buildFixture(): Promise<string> {
  const outPath = path.join(os.tmpdir(), `posted-step18-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
  await execFileAsync("python3", [path.join(__dirname, "fixtures", "build-posted-sheet-fixture-step18.py"), outPath]);
  return outPath;
}

async function resetMaster() {
  const sql = getDbClient();
  await sql`DELETE FROM lateral_master`;
  await sql`INSERT INTO lateral_master (job_requisition_id, posted) VALUES ('ATCI-7001-S1', '-')`;
}

async function inspectMasterColumnM(localPath: string): Promise<Record<string, string | null>> {
  const script = `
import json, sys
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1])
ws = wb["Master Sheet"]
result = {}
for r in range(2, ws.max_row + 1):
    jr = ws.cell(r, 2).value
    if jr:
        result[str(jr)] = ws.cell(r, 13).value
print(json.dumps(result))
`.trim();
  const scriptPath = path.join(os.tmpdir(), `posted-step18-inspect-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
  await fs.writeFile(scriptPath, script, "utf8");
  try {
    const { stdout } = await execFileAsync("python3", [scriptPath, localPath]);
    return JSON.parse(stdout.trim());
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

async function inspectPostedSheet(localPath: string) {
  const raw = await readPostedSheetTabRaw(localPath, "Posted Sheet");
  if (!raw.ok) throw new Error(`Failed to read Posted Sheet: ${raw.reason}`);
  const byJr: Record<string, { columnA: unknown; columnB: unknown; columnC: unknown }> = {};
  for (const row of raw.rows) {
    const key = String(row.columnB ?? row.columnA ?? row.rowNumber);
    byJr[key] = { columnA: row.columnA, columnB: row.columnB, columnC: row.columnC };
  }
  return byJr;
}

async function runPostedButtonOnLocalFile(localPath: string): Promise<void> {
  const folder = path.join(os.tmpdir(), `posted-step18-fakedrive-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const drive = await createFakeDrive({ folder, fileId: "fake-file", fileName: "fake.xlsm", seedLocalXlsmPath: localPath });
  process.env.ARA_POSTED_WRITES_ENABLED = "1";
  const result = await runLateralPostedButton({
    testHooks: { drive: drive.drive, fileId: "fake-file", fileName: "fake.xlsm", masterSheet: "Master Sheet", postedSheet: "Posted Sheet" },
  });
  delete process.env.ARA_POSTED_WRITES_ENABLED;
  assert(result.ok === true, `Posted button run failed: ${JSON.stringify(result)}`);
  const bytes = await drive.readCurrentBytes();
  await fs.writeFile(localPath, bytes);
}

async function runStep18OnLocalFile(localPath: string): Promise<void> {
  const result = await applyPostedSheetMatchingToStagedWorkbook({ localWorkbookPath: localPath, persistDatabase: true });
  assert(result.ok === true, `Step 18 run failed: ${JSON.stringify(result)}`);
}

async function main() {
  // --- Direction 1: Posted button first, then Step 18 ---
  await resetMaster();
  const file1 = await buildFixture();
  await runPostedButtonOnLocalFile(file1);
  await resetMaster(); // Step 18 does its own independent Postgres sync — same starting Postgres state for a fair comparison
  await runStep18OnLocalFile(file1);
  const posted1 = await inspectPostedSheet(file1);
  const masterM1 = await inspectMasterColumnM(file1);

  // --- Direction 2: Step 18 first, then Posted button ---
  await resetMaster();
  const file2 = await buildFixture();
  await runStep18OnLocalFile(file2);
  await resetMaster();
  await runPostedButtonOnLocalFile(file2);
  const posted2 = await inspectPostedSheet(file2);
  const masterM2 = await inspectMasterColumnM(file2);

  console.log("Direction 1 (Posted -> Step 18) Posted Sheet:", JSON.stringify(posted1));
  console.log("Direction 2 (Step 18 -> Posted) Posted Sheet:", JSON.stringify(posted2));
  console.log("Direction 1 Master Sheet column M:", JSON.stringify(masterM1));
  console.log("Direction 2 Master Sheet column M:", JSON.stringify(masterM2));

  const diffs: string[] = [];
  const allJrs = new Set([...Object.keys(posted1), ...Object.keys(posted2)]);
  for (const jr of allJrs) {
    const a = posted1[jr];
    const b = posted2[jr];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffs.push(`Posted Sheet row "${jr}": direction1=${JSON.stringify(a)} vs direction2=${JSON.stringify(b)}`);
    }
  }
  const allMasterJrs = new Set([...Object.keys(masterM1), ...Object.keys(masterM2)]);
  for (const jr of allMasterJrs) {
    if (masterM1[jr] !== masterM2[jr]) {
      diffs.push(`Master Sheet column M row "${jr}": direction1="${masterM1[jr]}" vs direction2="${masterM2[jr]}"`);
    }
  }

  if (diffs.length > 0) {
    console.error("DIFFERENCES FOUND:\n" + diffs.join("\n"));
    process.exit(1);
  }

  await fs.unlink(file1).catch(() => undefined);
  await fs.unlink(file2).catch(() => undefined);
  console.log("verify-posted-step18-roundtrip: OK — both run orders converge on the identical Posted Sheet and Master Sheet column M");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
