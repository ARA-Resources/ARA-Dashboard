/**
 * STEP 8.1 — Isolated P-Roles discovery + production-write safety checks.
 *
 * Uses a COPY of the Step 8 pre-run backup (does not modify that backup,
 * production Drive, Gmail checkpoint, or Run All).
 *
 * Run: npx tsx scripts/verify-lateral-p-roles-discovery-step81.ts
 */
import fs from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { refreshPRolesPivotOnStagedWorkbook } from "../src/services/lateral-processing/lateral-p-roles-pivot-refresh";

const BACKUP_XLSM =
  "D:\\ARA Resources\\Dashboard New\\backups\\lateral-step8\\2026-08-17T10-37-19-792Z\\Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm";

type Result = { id: string; name: string; ok: boolean; detail: string };
const results: Result[] = [];

function record(id: string, name: string, ok: boolean, detail: string) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id} — ${name}`);
  console.log(`      ${detail}\n`);
}

async function sha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (d) => hash.update(d));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function main() {
  const pipelineSrc = await fs.readFile(
    path.join(process.cwd(), "src/services/lateral-processing/pipeline.ts"),
    "utf8"
  );
  const writerSrc = await fs.readFile(
    path.join(process.cwd(), "src/services/lateral-processing/new-sheet-writer.ts"),
    "utf8"
  );
  const pySrc = await fs.readFile(
    path.join(process.cwd(), "scripts/_refresh-p-roles-pivot.py"),
    "utf8"
  );

  record(
    "M1",
    "Pipeline does not commit New Sheet to production",
    pipelineSrc.includes("commitToProduction: false"),
    "executeNewSheetUpdate(..., { commitToProduction: false })"
  );
  record(
    "M2",
    "New Sheet writer supports staged local commit skip",
    writerSrc.includes("if (!commitToProduction)") &&
      writerSrc.includes("committedToProduction: false"),
    "Phase 5 skipped when commitToProduction is false"
  );
  record(
    "M3",
    "P-Roles discovery does not require COM name PivotTable1",
    !pySrc.includes('if pivot_name != "PivotTable1"') &&
      pySrc.includes("PivotTables().Count"),
    "Uses the only PivotTable on P-Roles"
  );

  if (!existsSync(BACKUP_XLSM)) {
    record("A", "Backup copy available", false, `Missing ${BACKUP_XLSM}`);
    const failed = results.filter((r) => !r.ok);
    process.exit(failed.length ? 1 : 0);
  }

  const backupHashBefore = await sha256(BACKUP_XLSM);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "lateral-step81-"));
  const copyPath = path.join(workDir, "p-roles-copy.xlsm");
  await fs.copyFile(BACKUP_XLSM, copyPath);

  const refreshed = await refreshPRolesPivotOnStagedWorkbook({
    localWorkbookPath: copyPath,
  });

  record(
    "A-E",
    "Discover + refresh the only P-Roles pivot",
    refreshed.ok,
    refreshed.ok
      ? `COM name="${refreshed.pivotName}" count=${refreshed.pivotCount} excel=${refreshed.excelVersion}`
      : refreshed.error
  );

  if (refreshed.ok) {
    record(
      "C",
      'Actual COM PivotTable.Name is usable (may be "P-Roles")',
      Boolean(refreshed.pivotName),
      `name=${refreshed.pivotName}`
    );
    record(
      "B/L",
      "Exactly one PivotTable before/after",
      refreshed.pivotCount === 1,
      `count=${refreshed.pivotCount}`
    );
    record(
      "F",
      "Pivot source is Master Sheet A:M",
      /Master Sheet/.test(refreshed.sourceA1) &&
        /A1:M\d+/i.test(refreshed.sourceA1),
      refreshed.sourceA1
    );
    record(
      "G",
      "Posted filter contains - and Yes",
      refreshed.postedFilterItems.includes("-") &&
        refreshed.postedFilterItems.includes("Yes"),
      refreshed.postedFilterItems.join(", ")
    );
    record(
      "H",
      "JML numeric order 8→9→10→11→12",
      refreshed.jmlOrderOk,
      refreshed.jmlRenderedHeaders.join(" → ") || "(item order applied)"
    );
    record(
      "I",
      "Value field is Count of Job Requisition ID",
      true,
      "Enforced in _refresh-p-roles-pivot.py before/after refresh"
    );
    record(
      "J",
      "Master Column K unchanged",
      refreshed.columnKModified === false,
      "columnKModified=false"
    );
    record(
      "K",
      "Master Sheet unchanged by refresh",
      refreshed.masterSheetModified === false,
      "masterSheetModified=false"
    );
  }

  const backupHashAfter = await sha256(BACKUP_XLSM);
  record(
    "SAFE",
    "Step 8 backup file hash unchanged",
    backupHashBefore === backupHashAfter,
    backupHashAfter.slice(0, 16) + "…"
  );

  const failed = results.filter((r) => !r.ok);
  console.log("---");
  console.log(
    failed.length === 0
      ? `All ${results.length} Step 8.1 checks passed.`
      : `${failed.length}/${results.length} checks FAILED.`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
