/**
 * C6 validation — the sync orchestrator (parse → history row → engine →
 * finalize history row → result summary).
 *
 * Covers: a real successful (partial, since the real file has 2 known
 * duplicate-mismatch pairs) run against the actual Oorwin sample file, and
 * a parse-failure run against a garbage buffer — both checked against the
 * real candidate_sync_history row each produces, not just the returned
 * summary object.
 *
 * DESTRUCTIVE — writes to candidate_master / candidate_sync_history /
 * candidate_sync_changes / candidate_review_flags. Throwaway/test DB only.
 *
 * Run: npx tsx scripts/verify-candidate-sync-job.ts [pathToXlsFile]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { closeDbClient, getDbClient } from "../src/lib/persistence/db-client";
import { invokeCandidateSync } from "../src/services/candidate-processing/candidate-sync-job";

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
}

function check(results: TestResult[], name: string, pass: boolean, detail?: string) {
  results.push({ name, status: pass ? "PASS" : "FAIL", detail });
}

async function main() {
  const results: TestResult[] = [];
  const sql = getDbClient();

  try {
    const existingCount = Number(
      (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_master`)[0]?.c ?? "0"
    );
    if (existingCount > 100) {
      throw new Error(
        `candidate_master has ${existingCount} rows — refusing to run this destructive test against what looks like real data. Point POSTGRES_URL at a throwaway database.`
      );
    }

    // ===== Real file: successful (partial) run =====
    const filePath =
      process.argv[2] ||
      path.join(process.cwd(), "data", "excel", "ACCI Candidate Master Tracker Test - Anurag Shah-4.xls");
    const buffer = await fs.readFile(filePath);

    const realResult = await invokeCandidateSync(buffer, "anurag-sample.xls", "verify-script@test.local", sql);

    check(results, "Real file: syncId is set", realResult.syncId !== null, `${realResult.syncId}`);
    check(
      results,
      "Real file: result is 'partial' (2 known duplicate-mismatch pairs need review)",
      realResult.result === "partial",
      realResult.result
    );
    check(results, "Real file: rowsInSheet === 60", realResult.counts.rowsInSheet === 60, `${realResult.counts.rowsInSheet}`);
    check(
      results,
      "Real file: quarantined === 4 (the 2 known pairs, 2 rows each)",
      realResult.counts.quarantined === 4,
      `${realResult.counts.quarantined}`
    );
    check(
      results,
      "Real file: inserted === 56 (fresh DB, no pre-existing CIDs)",
      realResult.counts.inserted === 56,
      `${realResult.counts.inserted}`
    );
    check(results, "Real file: failureReason is null on a partial (not failed) run", realResult.failureReason === null);
    console.log(`(informational, not hand-verified) real file's reviewFlagCount this run: ${realResult.counts.reviewFlags}`);

    const historyRowReal = (await sql`SELECT * FROM candidate_sync_history WHERE id = ${realResult.syncId}`)[0];
    check(results, "Real file: candidate_sync_history row exists and matches", historyRowReal !== undefined);
    check(results, "Real file: history row result === 'partial'", historyRowReal?.result === "partial");
    check(results, "Real file: history row source_filename matches", historyRowReal?.source_filename === "anurag-sample.xls");
    check(
      results,
      "Real file: history row triggered_by matches",
      historyRowReal?.triggered_by === "verify-script@test.local"
    );
    check(results, "Real file: history row finished_at is set", historyRowReal?.finished_at !== null);
    check(
      results,
      "Real file: history row counts match the returned summary exactly",
      Number(historyRowReal?.inserted_count) === realResult.counts.inserted &&
        Number(historyRowReal?.quarantined_count) === realResult.counts.quarantined &&
        Number(historyRowReal?.review_flag_count) === realResult.counts.reviewFlags
    );

    // ===== Garbage buffer: parse-failure run =====
    const garbageBuffer = Buffer.from("this is not a real Excel file, just plain text");
    const failResult = await invokeCandidateSync(garbageBuffer, "garbage.xls", "verify-script@test.local", sql);

    check(results, "Garbage file: result is 'failed'", failResult.result === "failed", failResult.result);
    check(results, "Garbage file: syncId is still set (audit trail preserved)", failResult.syncId !== null);
    check(
      results,
      "Garbage file: failureReason is a non-empty message",
      typeof failResult.failureReason === "string" && failResult.failureReason.length > 0,
      failResult.failureReason ?? undefined
    );
    check(
      results,
      "Garbage file: all counts are zero (nothing was processed)",
      Object.values(failResult.counts).every((v) => v === 0)
    );

    const historyRowFail = (await sql`SELECT * FROM candidate_sync_history WHERE id = ${failResult.syncId}`)[0];
    check(results, "Garbage file: candidate_sync_history row exists with result='failed'", historyRowFail?.result === "failed");
    check(
      results,
      "Garbage file: history row failure_reason matches",
      historyRowFail?.failure_reason === failResult.failureReason
    );

    // -- cleanup --
    const realCids = (
      await sql<{ cid: string }[]>`
        SELECT DISTINCT cid FROM candidate_sync_changes WHERE sync_id = ${realResult.syncId}
        UNION
        SELECT cid FROM candidate_master WHERE date_of_upload = to_char(NOW(), 'DD/MM/YYYY')
      `
    ).map((r) => r.cid);
    if (realCids.length > 0) {
      await sql`DELETE FROM candidate_master WHERE cid = ANY(${realCids})`;
    }
    await sql`DELETE FROM candidate_review_flags WHERE sync_id IN (${realResult.syncId}, ${failResult.syncId})`;
    await sql`DELETE FROM candidate_sync_changes WHERE sync_id IN (${realResult.syncId}, ${failResult.syncId})`;
    await sql`DELETE FROM candidate_sync_history WHERE id IN (${realResult.syncId}, ${failResult.syncId})`;
  } finally {
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
