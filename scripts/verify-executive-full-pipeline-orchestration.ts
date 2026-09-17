/**
 * Checkpoint 3: fake-job orchestration test for Executive's new full
 * pipeline (Gmail search/Drive download stubbed with canned data; Postgres
 * writes go to a disposable throwaway table, never the real
 * `executive_master`; the Excel mirror write goes to a local scratch copy
 * of the real master workbook, downloaded read-only, NEVER re-uploaded to
 * Drive).
 *
 * Modes (via ORCHESTRATION_MODE env var):
 *  - "normal" (default): full A-O flow, everything should succeed.
 *  - "excel-fail": step K/M (the Excel mirror write) is forced to fail via
 *    an invalid local path. Proves the Postgres-first invariant: G/I must
 *    already be committed and correct, and the run must still report
 *    overall success with a flagged mirror failure, per the approved plan.
 *  - "db-fail": one row in this run's batch has a job_status value that
 *    violates executive_master's own CHECK constraint. Proves a genuine
 *    Postgres failure aborts the WHOLE run's DB writes (all-or-nothing,
 *    via a single transaction) and is reported as a real failure — not
 *    soft-failed, and the checkpoint must not be considered "advanced".
 *
 * Cleanup: the throwaway table is always dropped and all local temp files
 * removed in a `finally`, regardless of outcome.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import {
  resolveExecutiveBaseDsHeaderIndex,
  mapExecutiveBaseDsRow,
  type ExecutiveMappedRow,
} from "../src/services/executive-processing/executive-base-ds-mapping";
import { mapExecutiveRowsToNewSheetRows } from "../src/services/executive-processing/executive-new-sheet-mapping";
import {
  resolveExecutiveJobStatus,
  type ExecutiveMasterJobStatus,
} from "../src/services/executive-processing/executive-job-status-rules";
import { cleanExecutivePostedRows } from "../src/services/executive-processing/executive-posted-sheet-cleaner";
import {
  buildExecutivePostedDemandMap,
  resolveExecutivePostedFromDemandMap,
} from "../src/services/executive-processing/executive-posted-demand-rule";
import { writeExecutiveMasterWorkbookUpdates } from "../src/services/executive-processing/executive-master-workbook-writer";
import ExcelJS from "exceljs";

const MODE = (process.env.ORCHESTRATION_MODE || "normal") as
  | "normal"
  | "excel-fail"
  | "db-fail";

const TEST_TABLE = "executive_master_checkpoint3_test";
const MASTER_FILE_ID = "1AamiJ0-AK9xKHzDvLTcY8ovVsXdeYE-O";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function getDb() {
  const url = process.env.POSTGRES_URL?.trim();
  if (!url) throw new Error("POSTGRES_URL is not set.");
  return postgres(url, { max: 1, prepare: false, ssl: false });
}

// --- Canned "Gmail discovery + Drive download" stand-in: Base DS as in-memory header+rows ---
const BASE_DS_HEADERS = [
  "Job Requisition ID",
  "Final Market Map (Old)",
  "Final Market Map (New)",
  "Primary Skills",
  "Job Management Level",
  "Skill Categorization",
  "Primary Location",
  "Mandatory skill",
  "Location Flex",
  "Job Description",
  "Priority given to agency",
];

const BASE_DS_ROWS: unknown[][] = [
  // present this run -> exists in seed w/ Closed -> Reopen
  ["JR-CLOSED-TO-REOPEN", "EMEA-OLD", "EMEA-NEW", "Java", "7-Manager", "Core", "Pune", "Spring", "No Flex", "desc1", "High"],
  // present this run -> exists in seed w/ Active -> stays Active
  ["JR-ACTIVE-STAYS", "EMEA-OLD", "EMEA-NEW", "Python", "6-Senior Manager", "Premium", "Chennai", "Django", "Flex", "desc2", "Medium"],
  // present this run -> exists in seed w/ New (sticky) -> stays New
  ["JR-STICKY-NEW-STAYS", "EMEA-OLD", "EMEA-NEW", "Go", "7-Manager", "Core", "Bengaluru", "Gin", "No Flex", "desc3", "High"],
  // present this run -> exists in seed w/ Reopen (sticky) -> stays Reopen
  ["JR-STICKY-REOPEN-STAYS", "EMEA-OLD", "EMEA-NEW", "Rust", "6-Senior Manager", "Premium+", "Mumbai", "Actix", "Flex", "desc4", "Low"],
  // present this run -> exists in seed w/ blank status -> Active/Activated
  ["JR-EXISTING-BLANK-TO-ACTIVATE", "EMEA-OLD", "EMEA-NEW", "C++", "7-Manager", "Core", "Hyderabad", "Boost", "No Flex", "desc5", "High"],
  // brand new, not in seed at all -> New/Added
  ["JR-BRAND-NEW", "EMEA-OLD", "EMEA-NEW", "TypeScript", "6-Senior Manager", "Premium", "Pune", "Node", "Flex", "desc6", "Medium"],
  // JR-WILL-CLOSE deliberately NOT present this run -> Master-only -> Closed
];

// A real JR confirmed present in the actual Posted Sheet with Demand="Yes"
// (from this session's own prior live investigation) -- seeded into the
// throwaway table (untouched by Base DS/status logic) purely to prove the
// "found + Yes -> Yes" branch of the posted decision against REAL data,
// not just the "not found -> -" branch every synthetic JR will hit.
const REAL_POSTED_YES_JR = "ATCI-5678248-S2059207";

interface SeedRow {
  jobRequisitionId: string;
  jobStatus: ExecutiveMasterJobStatus | null;
}

const SEED_ROWS: SeedRow[] = [
  { jobRequisitionId: "JR-CLOSED-TO-REOPEN", jobStatus: "Closed" },
  { jobRequisitionId: "JR-ACTIVE-STAYS", jobStatus: "Active" },
  { jobRequisitionId: "JR-STICKY-NEW-STAYS", jobStatus: "New" },
  { jobRequisitionId: "JR-STICKY-REOPEN-STAYS", jobStatus: "Reopen" },
  { jobRequisitionId: "JR-EXISTING-BLANK-TO-ACTIVATE", jobStatus: null },
  { jobRequisitionId: "JR-WILL-CLOSE", jobStatus: "Active" },
  { jobRequisitionId: REAL_POSTED_YES_JR, jobStatus: "Active" },
];

async function main() {
  console.log(`=== Checkpoint 3 orchestration test — mode: ${MODE} ===\n`);
  const sql = getDb();
  let localWorkbookPath: string | null = null;

  try {
    // --- Setup: throwaway table, structurally identical to executive_master ---
    await sql.unsafe(`DROP TABLE IF EXISTS ${TEST_TABLE}`);
    await sql.unsafe(
      `CREATE TABLE ${TEST_TABLE} (LIKE executive_master INCLUDING ALL)`
    );
    console.log(`Created throwaway table ${TEST_TABLE}.`);

    for (const row of SEED_ROWS) {
      await sql`
        INSERT INTO ${sql(TEST_TABLE)} (job_requisition_id, job_status, posted)
        VALUES (${row.jobRequisitionId}, ${row.jobStatus}, '-')
      `;
    }
    console.log(`Seeded ${SEED_ROWS.length} rows.\n`);

    // ============================================================
    // D. Read Base DS tab, map columns (real Checkpoint-1 code, canned input)
    // ============================================================
    const headerIndex = resolveExecutiveBaseDsHeaderIndex(BASE_DS_HEADERS);
    assert(headerIndex.marketMap.source === "new", "canned Base DS: Market Map must resolve to (New) when both present");
    const mappedRows: ExecutiveMappedRow[] = BASE_DS_ROWS
      .map((row) => mapExecutiveBaseDsRow(headerIndex, row))
      .filter((r): r is ExecutiveMappedRow => r !== null);
    assert(mappedRows.length === BASE_DS_ROWS.length, "every canned row must map (all have JR IDs)");
    console.log(`D. Mapped ${mappedRows.length} Base DS rows.`);

    // ============================================================
    // E + F. Compare against throwaway executive_master, decide status
    // ============================================================
    const masterRows = await sql<{ job_requisition_id: string; job_status: string | null }[]>`
      SELECT job_requisition_id, job_status FROM ${sql(TEST_TABLE)}
    `;
    const masterStatusByJr = new Map(masterRows.map((r) => [r.job_requisition_id, r.job_status]));
    const newSheetJrSet = new Set(mappedRows.map((r) => r.jobRequisitionId));
    const allJrIds = new Set([...masterStatusByJr.keys(), ...newSheetJrSet]);

    const statusDecisions = new Map<string, ExecutiveMasterJobStatus>();
    for (const jr of allJrIds) {
      const resolution = resolveExecutiveJobStatus({
        existsInNewSheet: newSheetJrSet.has(jr),
        existsInMasterSheet: masterStatusByJr.has(jr),
        existingMasterStatus: masterStatusByJr.get(jr) ?? null,
      });
      if (resolution) statusDecisions.set(jr, resolution.status);
    }
    console.log(`F. Decided status for ${statusDecisions.size} JRs.`);

    const expectedStatus: Record<string, ExecutiveMasterJobStatus> = {
      "JR-CLOSED-TO-REOPEN": "Reopen",
      "JR-ACTIVE-STAYS": "Active",
      "JR-STICKY-NEW-STAYS": "New",
      "JR-STICKY-REOPEN-STAYS": "Reopen",
      "JR-EXISTING-BLANK-TO-ACTIVATE": "Active",
      "JR-BRAND-NEW": "New",
      "JR-WILL-CLOSE": "Closed",
    };
    for (const [jr, expected] of Object.entries(expectedStatus)) {
      const actual = statusDecisions.get(jr);
      assert(actual === expected, `status decision for ${jr}: expected ${expected}, got ${actual}`);
    }
    console.log("  All 7 status-decision branches (New/Reopen/Active/Closed + sticky New/Reopen) confirmed correct.\n");

    // ============================================================
    // G. Write status decisions to Postgres FIRST — single transaction,
    // all-or-nothing (proves the "db-fail" mode rolls back cleanly).
    // ============================================================
    const mappedByJr = new Map(mappedRows.map((r) => [r.jobRequisitionId, r]));
    let dbWriteFailed = false;
    let dbFailureReason = "";
    try {
      await sql.begin(async (tx) => {
        for (const [jr, status] of statusDecisions) {
          const mapped = mappedByJr.get(jr);
          // db-fail mode: corrupt one row's status value to violate the CHECK constraint.
          const statusToWrite =
            MODE === "db-fail" && jr === "JR-BRAND-NEW" ? "TOTALLY_INVALID_STATUS" : status;
          if (mapped) {
            await tx`
              INSERT INTO ${tx(TEST_TABLE)} (
                job_requisition_id, job_status, market_map, primary_skills,
                job_management_level, skill_categorization, primary_location,
                must_have_skills, location_flex, job_description, priority, posted
              ) VALUES (
                ${jr}, ${statusToWrite}, ${mapped.values.market_map}, ${mapped.values.primary_skills},
                ${mapped.values.job_management_level}, ${mapped.values.skill_categorization}, ${mapped.values.primary_location},
                ${mapped.values.must_have_skills}, ${mapped.values.location_flex}, ${mapped.values.job_description},
                ${mapped.values.priority}, '-'
              )
              ON CONFLICT (job_requisition_id) DO UPDATE SET
                job_status = EXCLUDED.job_status,
                market_map = EXCLUDED.market_map,
                primary_skills = EXCLUDED.primary_skills,
                job_management_level = EXCLUDED.job_management_level,
                skill_categorization = EXCLUDED.skill_categorization,
                primary_location = EXCLUDED.primary_location,
                must_have_skills = EXCLUDED.must_have_skills,
                location_flex = EXCLUDED.location_flex,
                job_description = EXCLUDED.job_description,
                priority = EXCLUDED.priority,
                updated_at = NOW()
            `;
          } else {
            await tx`
              UPDATE ${tx(TEST_TABLE)} SET job_status = ${statusToWrite}, updated_at = NOW()
              WHERE job_requisition_id = ${jr}
            `;
          }
        }
      });
      console.log("G. Postgres status writes committed (single transaction).\n");
    } catch (error) {
      dbWriteFailed = true;
      dbFailureReason = error instanceof Error ? error.message : String(error);
      console.log(`G. Postgres write FAILED (expected in db-fail mode): ${dbFailureReason}\n`);
    }

    if (MODE === "db-fail") {
      assert(dbWriteFailed, "db-fail mode must actually fail the Postgres write");
      assert(dbFailureReason.toLowerCase().includes("check"), `failure must be the CHECK constraint violation, got: ${dbFailureReason}`);

      // Prove the transaction rolled back EVERYTHING, not just the bad row.
      const afterFailure = await sql<{ job_requisition_id: string; job_status: string | null }[]>`
        SELECT job_requisition_id, job_status FROM ${sql(TEST_TABLE)} WHERE job_requisition_id = ANY(${Object.keys(expectedStatus)})
      `;
      for (const row of afterFailure) {
        const seed = SEED_ROWS.find((s) => s.jobRequisitionId === row.job_requisition_id);
        const expectedUnchanged = seed ? seed.jobStatus : null;
        assert(
          row.job_status === expectedUnchanged,
          `db-fail: ${row.job_requisition_id} must be UNCHANGED from seed (${expectedUnchanged}) after rollback, got ${row.job_status}`
        );
      }
      console.log("  Confirmed: ALL rows in this run's batch rolled back to their pre-run seed values — no partial write.");
      console.log("  Run correctly reports FAILURE; Gmail checkpoint must NOT be advanced in this mode.\n");
      console.log("=== db-fail mode: PASS (this is the expected/correct outcome for this mode) ===");
      return; // db-fail mode stops here by design — nothing after G should run on a real DB failure.
    }

    // ============================================================
    // H. Read/clean Posted Sheet — FULL fresh re-scan (not a sample),
    // downloaded read-only just now, not reused from earlier in the session.
    // ============================================================
    const { drive } = await getAuthorizedGmailClient();
    const resp = await drive.files.get(
      { fileId: MASTER_FILE_ID, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" }
    );
    localWorkbookPath = path.join(os.tmpdir(), `checkpoint3-master-${Date.now()}.xlsm`);
    await fs.writeFile(localWorkbookPath, Buffer.from(resp.data as ArrayBuffer));
    console.log(`H. Downloaded fresh master workbook for full Posted Sheet re-scan: ${localWorkbookPath}`);

    const wbForScan = new ExcelJS.Workbook();
    await wbForScan.xlsx.readFile(localWorkbookPath);
    const postedWs = wbForScan.worksheets.find((w) => w.name === "Posted Sheet")!;
    const rawRows = [];
    for (let r = 2; r <= postedWs.actualRowCount + 1; r++) {
      const row = postedWs.getRow(r);
      const a = row.getCell(1).value;
      const c = row.getCell(3).value;
      if (a === null || a === undefined || a === "") continue;
      rawRows.push({ rowNumber: r, columnA: a, columnC: c });
    }
    const cleanResult = cleanExecutivePostedRows(rawRows);
    console.log(`  Full scan: ${rawRows.length} non-empty raw rows -> ${cleanResult.kept.length} kept, ${cleanResult.removed.length} removed.`);

    const demandValues = new Set(cleanResult.kept.map((r) => String(r.demand ?? "").trim()));
    console.log(`  Distinct Demand values seen across the FULL sheet: ${JSON.stringify([...demandValues])}`);
    const unexpectedDemand = [...demandValues].filter((v) => v !== "Yes" && v !== "No" && v !== "");
    if (unexpectedDemand.length > 0) {
      console.log(`  NOTE: unexpected Demand values found (not just Yes/No): ${JSON.stringify(unexpectedDemand)} — buildExecutivePostedDemandMap already safely excludes anything not exactly Yes/No.`);
    } else {
      console.log("  Confirmed: every kept row's Demand value across the FULL sheet is exactly Yes/No/blank — no malformed values found.");
    }
    const malformedCount = cleanResult.removed.length;
    console.log(`  ${malformedCount} row(s) failed the "starts with ATCI" check across the full sheet (removed).\n`);

    // ============================================================
    // I. Write posted decisions to Postgres (reusing the real pure logic
    // functions directly against the throwaway table — the production
    // executive-posted-refresh.ts intentionally hardcodes the real table
    // name and is not meant to be redirected).
    // ============================================================
    const demandMap = buildExecutivePostedDemandMap(
      cleanResult.kept.map((r) => ({ jobRequisitionId: r.jobRequisitionId, demand: r.demand }))
    );
    const throwawayJrRows = await sql<{ job_requisition_id: string }[]>`
      SELECT job_requisition_id FROM ${sql(TEST_TABLE)}
    `;
    const postedDecisions = throwawayJrRows.map((r) => ({
      jobRequisitionId: r.job_requisition_id,
      posted: resolveExecutivePostedFromDemandMap(r.job_requisition_id, demandMap),
    }));
    await sql.begin(async (tx) => {
      for (const d of postedDecisions) {
        await tx`
          UPDATE ${tx(TEST_TABLE)} SET posted = ${d.posted}, updated_at = NOW()
          WHERE job_requisition_id = ${d.jobRequisitionId}
        `;
      }
    });
    console.log(`I. Posted decisions written for ${postedDecisions.length} JRs.\n`);

    const realJrPosted = postedDecisions.find((d) => d.jobRequisitionId === REAL_POSTED_YES_JR);
    assert(!!realJrPosted, `${REAL_POSTED_YES_JR} must be in the throwaway table`);
    assert(
      realJrPosted!.posted === "Yes",
      `${REAL_POSTED_YES_JR} is confirmed present in the REAL Posted Sheet with Demand=Yes — expected posted="Yes", got "${realJrPosted!.posted}"`
    );
    console.log(`  Confirmed against REAL data: ${REAL_POSTED_YES_JR} correctly resolved posted="Yes".`);
    const syntheticJrPosted = postedDecisions.find((d) => d.jobRequisitionId === "JR-BRAND-NEW");
    assert(syntheticJrPosted?.posted === "-", `synthetic JR not in real Posted Sheet must resolve to "-"`);
    console.log(`  Confirmed: synthetic JRs not present in the real Posted Sheet correctly resolved posted="-".\n`);

    // ============================================================
    // Postgres-first checkpoint: verify the FULL final DB state now,
    // BEFORE attempting the Excel mirror — this is the state that must
    // survive untouched regardless of what happens next.
    // ============================================================
    const finalDbState = await sql<{ job_requisition_id: string; job_status: string; posted: string }[]>`
      SELECT job_requisition_id, job_status, posted FROM ${sql(TEST_TABLE)}
      WHERE job_requisition_id = ANY(${[...Object.keys(expectedStatus), REAL_POSTED_YES_JR]})
      ORDER BY job_requisition_id
    `;
    console.log("Postgres state after G+I (source of dashboard truth):");
    console.log(JSON.stringify(finalDbState, null, 2));
    for (const [jr, expected] of Object.entries(expectedStatus)) {
      const row = finalDbState.find((r) => r.job_requisition_id === jr);
      assert(row?.job_status === expected, `final DB check: ${jr} status must be ${expected}, got ${row?.job_status}`);
    }
    console.log();

    // ============================================================
    // J + K. Excel mirror: write New Sheet + Master Sheet on the LOCAL
    // scratch copy only. Never re-uploaded to Drive (M is stubbed/skipped
    // entirely in this test — no live Drive write of any kind).
    // ============================================================
    const newSheetRows = mapExecutiveRowsToNewSheetRows(mappedRows);
    const masterSheetUpdates = [...statusDecisions.entries()].map(([jr, status]) => {
      const posted = postedDecisions.find((d) => d.jobRequisitionId === jr)?.posted ?? "-";
      return { jobRequisitionId: jr, fields: { "Job Status": status, Posted: posted } };
    });

    const writePath =
      MODE === "excel-fail"
        ? "/nonexistent/directory/does-not-exist.xlsm"
        : localWorkbookPath;

    console.log(`K. Writing Excel mirror to: ${writePath} ${MODE === "excel-fail" ? "(deliberately invalid path)" : ""}`);
    const writeResult = await writeExecutiveMasterWorkbookUpdates({
      localPath: writePath,
      newSheetRows,
      masterSheetUpdates,
    });

    if (MODE === "excel-fail") {
      assert(!writeResult.ok, "excel-fail mode must actually fail the Excel mirror write");
      console.log(`  Excel mirror write FAILED as expected: ${(writeResult as { reason: string }).reason}`);
      console.log("  Per the Postgres-first invariant, this failure must NOT roll back or affect Postgres.\n");

      // Re-verify Postgres state is STILL correct after the mirror failure.
      const dbAfterMirrorFailure = await sql<{ job_requisition_id: string; job_status: string; posted: string }[]>`
        SELECT job_requisition_id, job_status, posted FROM ${sql(TEST_TABLE)}
        WHERE job_requisition_id = ANY(${[...Object.keys(expectedStatus), REAL_POSTED_YES_JR]})
        ORDER BY job_requisition_id
      `;
      for (const [jr, expected] of Object.entries(expectedStatus)) {
        const row = dbAfterMirrorFailure.find((r) => r.job_requisition_id === jr);
        assert(row?.job_status === expected, `POST-MIRROR-FAILURE check: ${jr} status must STILL be ${expected}, got ${row?.job_status}`);
      }
      const realRow = dbAfterMirrorFailure.find((r) => r.job_requisition_id === REAL_POSTED_YES_JR);
      assert(realRow?.posted === "Yes", `POST-MIRROR-FAILURE check: ${REAL_POSTED_YES_JR} posted must STILL be "Yes"`);
      console.log("  CONFIRMED: Postgres is untouched and still fully correct after the Excel mirror failure.");
      console.log("  The overall run must report SUCCESS (dashboard truth is correct) with a flagged");
      console.log("  'Excel mirror not updated' note — exactly like Lateral's existing");
      console.log("  'Skipped VBA finalize (Postgres primary)' pattern. Gmail checkpoint SHOULD advance.\n");
      console.log("=== excel-fail mode: PASS (Postgres-first invariant holds under a real mirror failure) ===");
      return;
    }

    assert(writeResult.ok, `normal mode: Excel mirror write must succeed, got: ${JSON.stringify(writeResult)}`);
    if (writeResult.ok) {
      console.log(`  Excel mirror write OK: ${writeResult.newSheetRowsWritten} New Sheet rows, ${writeResult.masterUpdatesApplied.length} Master Sheet updates applied, ${writeResult.masterUpdatesSkipped.length} skipped.`);
      // 7 synthetic JRs don't exist in the real Master Sheet -> skipped.
      // REAL_POSTED_YES_JR is also in statusDecisions (seeded, but absent from
      // this run's canned Base DS -> resolves to Closed) and DOES exist as a
      // real row in the real Master Sheet -> correctly found and applied.
      assert(
        writeResult.masterUpdatesApplied.length === 1 && writeResult.masterUpdatesApplied[0] === REAL_POSTED_YES_JR,
        `expected exactly 1 applied update (the real JR), got: ${JSON.stringify(writeResult.masterUpdatesApplied)}`
      );
      assert(
        writeResult.masterUpdatesSkipped.length === 7,
        `expected exactly 7 skipped (the 7 synthetic JRs), got ${writeResult.masterUpdatesSkipped.length}: ${JSON.stringify(writeResult.masterUpdatesSkipped)}`
      );
      console.log(`  Confirmed: the one JR that's both in this run's decisions AND a real Master Sheet row (${REAL_POSTED_YES_JR}) was correctly found and updated; all 7 synthetic JRs were correctly skipped (not found), not errored.`);
    }
    console.log();

    // Reread the local mirror to confirm it reflects the same decisions as Postgres.
    const wbAfterWrite = new ExcelJS.Workbook();
    await wbAfterWrite.xlsx.readFile(localWorkbookPath);
    const newSheetAfter = wbAfterWrite.worksheets.find((w) => w.name === "New Sheet")!;
    const nsRow2 = newSheetAfter.getRow(2);
    console.log("New Sheet row 2 after write:", JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((c) => nsRow2.getCell(c).value)));
    assert(
      nsRow2.getCell(1).value === BASE_DS_ROWS[0][0],
      "New Sheet row 2 must be the first canned Base DS row"
    );
    assert(nsRow2.getCell(11).value === null, "New Sheet Posted column must be blank");
    console.log("  Confirmed: Excel mirror's New Sheet matches this run's Base DS data, Posted column blank.");

    const masterAfter = wbAfterWrite.worksheets.find((w) => w.name === "Master Sheet")!;
    let realJrRow: number | null = null;
    for (let r = 2; r <= masterAfter.actualRowCount + 1; r++) {
      if (masterAfter.getCell(r, 1).value === REAL_POSTED_YES_JR) {
        realJrRow = r;
        break;
      }
    }
    assert(realJrRow !== null, `${REAL_POSTED_YES_JR} must be found as a real row in Master Sheet`);
    assert(
      masterAfter.getCell(realJrRow!, 10).value === "Closed",
      `Master Sheet's real row for ${REAL_POSTED_YES_JR} must show Job Status="Closed" (this run's decision), got ${masterAfter.getCell(realJrRow!, 10).value}`
    );
    console.log(`  Confirmed: the real Master Sheet row for ${REAL_POSTED_YES_JR} (row ${realJrRow}) was actually updated with this run's decision.\n`);

    console.log("L. Macro situation: openpyxl save already drops all drawing/shape content (proven in Checkpoint 2) — no separate action needed, re-confirmed implicitly by this write succeeding via the same writer.");
    console.log("M. Re-upload to Drive: STUBBED — not performed, per Checkpoint 3 scope (no live Drive writes).");
    console.log("N. Advance Gmail checkpoint: STUBBED — would advance now, since G+I (Postgres) succeeded.");
    console.log("O. Refresh dashboard metrics: STUBBED — existing, unchanged call, not exercised here.\n");

    console.log("=== normal mode: PASS — full A-O flow (with M/N/O stubbed) completed successfully ===");
  } finally {
    await sql.unsafe(`DROP TABLE IF EXISTS ${TEST_TABLE}`).catch(() => undefined);
    if (localWorkbookPath) await fs.unlink(localWorkbookPath).catch(() => undefined);
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("ORCHESTRATION TEST FAILED:", err);
  process.exit(1);
});
