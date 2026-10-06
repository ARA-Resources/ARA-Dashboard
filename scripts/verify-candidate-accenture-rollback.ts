/**
 * Validates scripts/candidate-accenture-rollback.ts against the REAL
 * replay engine's output (not a hand-built fixture) — runs an actual
 * replay sync touching several CIDs/fields (multi-field rows, a revert,
 * a brand-new insert, a frozen field), snapshots candidate_master before,
 * rolls back via the script's own exported logic path, and asserts the
 * after-rollback state is byte-identical to the before snapshot — except
 * for the one deliberately-frozen field, which the rollback correctly
 * leaves alone (it was never touched by the run being rolled back).
 *
 * DESTRUCTIVE — throwaway/test DB only. Self-cleans in a `finally` block.
 *
 * Run: npx tsx scripts/verify-candidate-accenture-rollback.ts
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { closeDbClient, getDbClient } from "../src/lib/persistence/db-client";
import { getCandidateMasterById, type SqlClient } from "../src/services/persistence/read-candidate-master";
import { runCandidateAccentureReplaySync } from "../src/services/candidate-processing/candidate-accenture-replay-engine";
import type { CandidateAccentureParsedRow } from "../src/services/candidate-processing/candidate-accenture-parser";

const execFileAsync = promisify(execFile);

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
}
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail?: string) {
  results.push({ name, status: pass ? "PASS" : "FAIL", detail });
}

const RUN_ID = Date.now();
const CID = (n: number) => `C7${RUN_ID}${n}`;
const cidsUsed: string[] = [];
const syncIdsUsed: number[] = [];

function serial(dateStr: string): string {
  const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
  const ms = new Date(`${dateStr}T00:00:00.000Z`).getTime();
  return String(Math.round((ms - EXCEL_EPOCH_UTC_MS) / 86_400_000));
}

function fileRow(cid: string, date: string, overrides: Partial<CandidateAccentureParsedRow> = {}): CandidateAccentureParsedRow {
  return {
    sheetRowNumber: 1,
    cid,
    name: "File Name",
    email: "-",
    level: "-",
    applicationCompletionStatus: "-",
    candidateStage: "-",
    currentCidSource: "-",
    reportDateRaw: serial(date),
    ...overrides,
  };
}

async function seedRow(
  sql: SqlClient,
  cid: string,
  overrides: Partial<{ accenture_candidate_stage: string; current_cid_source: string; email: string; job_management_level: string }> = {}
) {
  cidsUsed.push(cid);
  const [{ id }] = await sql<{ id: number }[]>`
    INSERT INTO candidate_master (
      cid, name, gender, contact_number, date_of_upload, submitter, customer,
      job_requisition_id, primary_skills, job_management_level, market,
      client_spoc, status, accenture_candidate_stage, current_cid_source,
      application_completion_status, screening_candidate_stage, disposition_reason,
      submitted_date, submission_comments, email
    ) VALUES (
      ${cid}, 'Seed Name', '-', '-', '-', '-', '-',
      '-', '-', ${overrides.job_management_level ?? "-"}, '-',
      '-', '-', ${overrides.accenture_candidate_stage ?? "-"}, ${overrides.current_cid_source ?? "-"},
      '-', '-', '-',
      '-', '-', ${overrides.email ?? "-"}
    ) RETURNING id
  `;
  const row = await getCandidateMasterById(Number(id), sql);
  if (!row) throw new Error("seedRow: row vanished immediately after insert");
  return row;
}

function snapshotRow(r: NonNullable<Awaited<ReturnType<typeof getCandidateMasterById>>>) {
  return {
    email: r.email,
    job_management_level: r.job_management_level,
    accenture_candidate_stage: r.accenture_candidate_stage,
    current_cid_source: r.current_cid_source,
    application_completion_status: r.application_completion_status,
    email_accenture_locked: r.email_accenture_locked,
    job_management_level_accenture_locked: r.job_management_level_accenture_locked,
    last_accenture_sync_id: r.last_accenture_sync_id,
    last_accenture_report_date: r.last_accenture_report_date,
  };
}

async function runRollbackCli(syncId: number, url: string, extraArgs: string[] = []): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync(
      "node_modules/.bin/tsx",
      ["scripts/candidate-accenture-rollback.ts", `--sync-id=${syncId}`, ...extraArgs],
      { env: { ...process.env, POSTGRES_URL: url }, cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 }
    );
    return { stdout, code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; code?: number };
    return { stdout: e.stdout ?? "", code: e.code ?? 1 };
  }
}

async function main() {
  const sql = getDbClient();
  const url = process.env.POSTGRES_URL?.trim();
  if (!url) throw new Error("POSTGRES_URL is not set.");

  const existingCount = Number((await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_master`)[0]?.c ?? "0");
  if (existingCount > 100) {
    throw new Error(`candidate_master has ${existingCount} rows — refusing to run against what looks like real data.`);
  }

  try {
    // --- Build a multi-CID run: a matched row with 2 touched fields (the exact
    // bug the v1 hand-built rehearsal caught), a revert, a frozen field, and an insert. ---
    const cidMulti = CID(1);
    const seedMulti = await seedRow(sql, cidMulti, { accenture_candidate_stage: "-", email: "-" });
    const beforeMulti = snapshotRow(seedMulti);

    const cidRevert = CID(2);
    const seedRevert = await seedRow(sql, cidRevert, { accenture_candidate_stage: "A" });
    const beforeRevert = snapshotRow(seedRevert);

    const cidFrozen = CID(3);
    const seedFrozen = await seedRow(sql, cidFrozen, { accenture_candidate_stage: "-" });
    // A real edit AFTER this run's file's last date (2026-09-01) — frozen trigger.
    await sql`
      INSERT INTO candidate_sync_changes (sync_id, cid, field_name, old_value, new_value, candidate_master_id, changed_at)
      VALUES (NULL, ${cidFrozen}, 'accenture_candidate_stage', '-', 'ManualValue', ${seedFrozen.id}, '2026-10-10T06:30:00Z')
    `;
    await sql`UPDATE candidate_master SET accenture_candidate_stage = 'ManualValue' WHERE id = ${seedFrozen.id}`;
    const beforeFrozen = snapshotRow((await getCandidateMasterById(seedFrozen.id, sql))!);

    const cidInsert = CID(4);

    // Level revert using a LEGACY free-text seed ("9-Team Lead/Consultant", not
    // "CL9") — the chain compares by NUMBER (normalizeStoredLevel), so a
    // revert back to the same number must restore the row's true original
    // free-text value, not the chain's normalized "CL9" seed form. This is
    // exactly the bug found rehearsing the real 51k-row file at full scale.
    const cidLevelRevert = CID(5);
    const seedLevelRevert = await seedRow(sql, cidLevelRevert, { job_management_level: "9-Team Lead/Consultant" });
    const beforeLevelRevert = snapshotRow(seedLevelRevert);

    const [{ id: syncId }] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, result, kind) VALUES (NOW(), 'success', 'accenture_upload') RETURNING id
    `;
    syncIdsUsed.push(Number(syncId));

    const rows = [
      fileRow(cidMulti, "2026-01-26", { candidateStage: "Screen", email: "a@x.com" }),
      fileRow(cidRevert, "2026-02-10", { candidateStage: "B" }),
      fileRow(cidRevert, "2026-03-05", { candidateStage: "A" }),
      fileRow(cidFrozen, "2026-09-01", { candidateStage: "Screen" }),
      fileRow(cidInsert, "2026-01-26", { candidateStage: "New", email: "new@x.com" }),
      fileRow(cidLevelRevert, "2026-02-10", { level: "CL8" }),
      fileRow(cidLevelRevert, "2026-03-05", { level: "9-Team Lead/Consultant" }),
    ];
    const summary = await runCandidateAccentureReplaySync(rows, Number(syncId), sql, { dryRun: false });
    cidsUsed.push(cidInsert);
    check("Setup: run touched/inserted as expected (sanity)", summary.insertedCount === 1 && summary.matchedCidCount === 4, JSON.stringify(summary));

    const afterMulti = snapshotRow((await getCandidateMasterById(seedMulti.id, sql))!);
    check(
      "Setup sanity: the multi-field row actually changed on BOTH fields (this is what the pivot bug would otherwise only restore one of)",
      afterMulti.accenture_candidate_stage === "Screen" && afterMulti.email === "a@x.com",
      JSON.stringify(afterMulti)
    );
    const afterLevelRevert = snapshotRow((await getCandidateMasterById(seedLevelRevert.id, sql))!);
    check(
      "Setup sanity: the level-revert row's live column was NEVER touched (still the true original free-text value)",
      afterLevelRevert.job_management_level === "9-Team Lead/Consultant",
      afterLevelRevert.job_management_level
    );
    const insertedRow = (await sql<{ id: number }[]>`SELECT id FROM candidate_master WHERE cid = ${cidInsert}`)[0];

    // --- Dry-run rollback preview: zero writes ---
    const dryRunResult = await runRollbackCli(Number(syncId), url);
    check("Rollback dry run: exit code 0", dryRunResult.code === 0, dryRunResult.stdout);
    check("Rollback dry run: reports touchedRowCount 5 (4 matched + 1 inserted)", dryRunResult.stdout.includes("touchedRowCount (matched + inserted): 5"), dryRunResult.stdout);
    const stillThereAfterDryRun = await getCandidateMasterById(seedMulti.id, sql);
    check("Rollback dry run: did NOT actually restore anything yet", stillThereAfterDryRun?.accenture_candidate_stage === "Screen", stillThereAfterDryRun?.accenture_candidate_stage);

    // --- Apply rollback ---
    const applyResult = await runRollbackCli(Number(syncId), url, ["--apply", "--confirm-rows=5"]);
    check("Rollback apply: exit code 0", applyResult.code === 0, applyResult.stdout);

    const afterRollbackMulti = snapshotRow((await getCandidateMasterById(seedMulti.id, sql))!);
    check(
      "Rollback: multi-field row restored EXACTLY to its before-snapshot (both fields, not just one)",
      JSON.stringify(afterRollbackMulti) === JSON.stringify(beforeMulti),
      `before=${JSON.stringify(beforeMulti)} after=${JSON.stringify(afterRollbackMulti)}`
    );

    const afterRollbackRevert = snapshotRow((await getCandidateMasterById(seedRevert.id, sql))!);
    check(
      "Rollback: revert-case row restored exactly (was already back at A, stays A, locks/sync-id cleared)",
      JSON.stringify(afterRollbackRevert) === JSON.stringify(beforeRevert),
      `before=${JSON.stringify(beforeRevert)} after=${JSON.stringify(afterRollbackRevert)}`
    );

    const afterRollbackFrozen = snapshotRow((await getCandidateMasterById(seedFrozen.id, sql))!);
    check(
      "Rollback: frozen-field row is UNCHANGED by rollback too (the run never touched its live value, so there's nothing to restore)",
      JSON.stringify(afterRollbackFrozen) === JSON.stringify(beforeFrozen),
      `before=${JSON.stringify(beforeFrozen)} after=${JSON.stringify(afterRollbackFrozen)}`
    );

    const afterRollbackLevelRevert = snapshotRow((await getCandidateMasterById(seedLevelRevert.id, sql))!);
    check(
      "Rollback: level-revert row restored to its TRUE original free-text value, not the chain's normalized CL9 seed form — the exact bug found at full scale",
      JSON.stringify(afterRollbackLevelRevert) === JSON.stringify(beforeLevelRevert),
      `before=${JSON.stringify(beforeLevelRevert)} after=${JSON.stringify(afterRollbackLevelRevert)}`
    );

    const insertedGone = await sql<{ id: number }[]>`SELECT id FROM candidate_master WHERE id = ${insertedRow.id}`;
    check("Rollback: the inserted row is fully gone", insertedGone.length === 0, String(insertedGone.length));

    const historyGone = await sql<{ id: number }[]>`SELECT id FROM candidate_sync_changes WHERE sync_id = ${syncId}`;
    check("Rollback: all of this run's history rows are gone", historyGone.length === 0, String(historyGone.length));
    const runGone = await sql<{ id: number }[]>`SELECT id FROM candidate_sync_history WHERE id = ${syncId}`;
    check("Rollback: the sync_history row itself is gone", runGone.length === 0, String(runGone.length));

    // The frozen CID's own synthetic manual-edit history row was NOT touched (different sync_id).
    const frozenManualStillThere = await sql<{ id: number }[]>`
      SELECT id FROM candidate_sync_changes WHERE candidate_master_id = ${seedFrozen.id} AND sync_id IS NULL
    `;
    check("Rollback: the frozen field's own (unrelated) manual-edit history row survives untouched", frozenManualStillThere.length === 1, String(frozenManualStillThere.length));
  } finally {
    await sql`DELETE FROM candidate_sync_changes WHERE cid = ANY(${cidsUsed})`;
    await sql`DELETE FROM candidate_master WHERE cid = ANY(${cidsUsed})`;
    if (syncIdsUsed.length > 0) {
      await sql`DELETE FROM candidate_sync_history WHERE id = ANY(${syncIdsUsed})`;
    }
    await closeDbClient();
  }

  console.log("\n========== TEST RESULTS ==========");
  let failures = 0;
  for (const r of results) {
    console.log(`[${r.status}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    if (r.status === "FAIL") failures += 1;
  }
  console.log(`\n${results.length - failures}/${results.length} passed.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
