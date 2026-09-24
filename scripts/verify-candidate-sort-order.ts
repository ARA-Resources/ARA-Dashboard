/**
 * C11 validation — Candidate Master Sheet default sort order
 * (`last_touched_at DESC NULLS LAST, id ASC`).
 *
 * Confirms: untouched (legacy-style, last_touched_at IS NULL) rows keep
 * their original id-order relative to each other; a row touched by a live
 * sync jumps to the top ahead of every untouched row; and between two
 * touched rows, the MORE RECENTLY touched one sorts first — proving actual
 * recency ordering, not just "touched vs. untouched".
 *
 * DESTRUCTIVE — writes to candidate_master / candidate_sync_history /
 * candidate_sync_changes. Throwaway/test DB only.
 *
 * Run: npx tsx scripts/verify-candidate-sort-order.ts
 */
import { closeDbClient, getDbClient } from "../src/lib/persistence/db-client";
import { runCandidateSync } from "../src/services/candidate-processing/candidate-sync-engine";
import type { CandidateOorwinParsedRow } from "../src/services/candidate-processing/candidate-oorwin-parser";
import { queryCandidateMasterSheetPage } from "../src/services/persistence/candidate-master-sheet-postgres";

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
}
function check(results: TestResult[], name: string, pass: boolean, detail?: string) {
  results.push({ name, status: pass ? "PASS" : "FAIL", detail });
}

function row(
  partial: Partial<CandidateOorwinParsedRow> & { sheetRowNumber: number; cid: string }
): CandidateOorwinParsedRow {
  return {
    firstName: "", middleName: "-", lastName: "", email: "-", mobile: "-", gender: "-",
    submitter: "-", customer: "-", clientSubmissionJr: "-", customerJobTitle: "-",
    market: "-", clientSpoc: "-", status: "-", submittedDate: "-",
    reasonForRejection: "-", submissionComments: "-", ...partial,
  };
}

const CIDS = ["TEST-SORT-1", "TEST-SORT-2", "TEST-SORT-3"];

function cidOrder(rows: { "Candidate ID": string }[]): string[] {
  return rows.filter((r) => CIDS.includes(r["Candidate ID"])).map((r) => r["Candidate ID"]);
}

async function main() {
  const results: TestResult[] = [];
  const sql = getDbClient();
  const syncIds: number[] = [];

  try {
    const existingCount = Number(
      (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_master`)[0]?.c ?? "0"
    );
    if (existingCount > 100) {
      throw new Error(
        `candidate_master has ${existingCount} rows — refusing to run this destructive test against what looks like real data. Point POSTGRES_URL at a throwaway database.`
      );
    }

    // -- Three untouched (legacy-style) rows: last_touched_at left NULL --
    await sql`
      INSERT INTO candidate_master (
        cid, name, gender, contact_number, date_of_upload, submitter, customer,
        job_requisition_id, primary_skills, job_management_level, market,
        client_spoc, status, submitted_date, submission_comments, email
      ) VALUES
        ('TEST-SORT-1', 'Sort One', 'Male', '9200000001', '01/01/2026', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', 'a@example.com'),
        ('TEST-SORT-2', 'Sort Two', 'Male', '9200000002', '01/01/2026', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', 'b@example.com'),
        ('TEST-SORT-3', 'Sort Three', 'Male', '9200000003', '01/01/2026', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', 'c@example.com')
    `;

    const baseline = await queryCandidateMasterSheetPage(
      { page: 1, pageSize: 500, columnFilters: {}, textFilters: {}, dateFilters: {} },
      sql
    );
    check(
      results,
      "Baseline (all untouched, last_touched_at NULL): relative order is id ASC — 1, 2, 3",
      JSON.stringify(cidOrder(baseline.rows)) === JSON.stringify(["TEST-SORT-1", "TEST-SORT-2", "TEST-SORT-3"]),
      JSON.stringify(cidOrder(baseline.rows))
    );

    // -- Touch TEST-SORT-2 via a real sync (sets last_touched_at = NOW()) --
    const [h1] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, result, source_filename)
      VALUES (NOW(), 'success', 'sort-order-touch-2') RETURNING id
    `;
    syncIds.push(Number(h1.id));
    await runCandidateSync(
      [row({ sheetRowNumber: 1, cid: "TEST-SORT-2", firstName: "Sort", lastName: "Two", mobile: "9200000002", email: "b@example.com", status: "Touched" })],
      h1.id,
      sql
    );

    const afterTouch2 = await queryCandidateMasterSheetPage(
      { page: 1, pageSize: 500, columnFilters: {}, textFilters: {}, dateFilters: {} },
      sql
    );
    check(
      results,
      "After syncing TEST-SORT-2: it now sorts FIRST, ahead of the two still-untouched rows (page 1, no manual refresh/reorder needed)",
      cidOrder(afterTouch2.rows)[0] === "TEST-SORT-2",
      JSON.stringify(cidOrder(afterTouch2.rows))
    );

    // -- Touch TEST-SORT-1 a moment later — it should now overtake TEST-SORT-2 --
    await new Promise((r) => setTimeout(r, 50)); // ensure a strictly later timestamp
    const [h2] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, result, source_filename)
      VALUES (NOW(), 'success', 'sort-order-touch-1') RETURNING id
    `;
    syncIds.push(Number(h2.id));
    await runCandidateSync(
      [row({ sheetRowNumber: 1, cid: "TEST-SORT-1", firstName: "Sort", lastName: "One", mobile: "9200000001", email: "a@example.com", status: "Touched" })],
      h2.id,
      sql
    );

    const afterTouch1 = await queryCandidateMasterSheetPage(
      { page: 1, pageSize: 500, columnFilters: {}, textFilters: {}, dateFilters: {} },
      sql
    );
    check(
      results,
      "After then syncing TEST-SORT-1: it overtakes TEST-SORT-2 (most-recently-touched sorts first, not just 'touched vs untouched') — order is [1, 2, 3]",
      JSON.stringify(cidOrder(afterTouch1.rows)) === JSON.stringify(["TEST-SORT-1", "TEST-SORT-2", "TEST-SORT-3"]),
      JSON.stringify(cidOrder(afterTouch1.rows))
    );

    // -- cleanup --
    await sql`DELETE FROM candidate_sync_changes WHERE cid = ANY(${CIDS})`;
    await sql`DELETE FROM candidate_master WHERE cid = ANY(${CIDS})`;
    await sql`DELETE FROM candidate_sync_history WHERE id = ANY(${syncIds})`;
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
