/**
 * Direct data-layer verification for item #3: "filter the Candidate Master
 * Sheet by a specific sync's rows" (candidate_master.inserted_sync_id,
 * migration 019, + the syncFilter predicate in candidate-master-sheet-postgres.ts).
 *
 * Seeds two candidate_sync_history rows (a target sync + a decoy sync) and
 * four candidate_master rows covering every way a row can be "touched" by
 * the target sync:
 *  - C900101: inserted BY the target sync (inserted_sync_id set, no
 *    changes/flags rows) — the case #3 exists to fix (previously invisible).
 *  - C900102: pre-existing row, UPDATED by the target sync (a
 *    candidate_sync_changes row with that sync_id).
 *  - C900103: pre-existing row, FLAGGED by the target sync (a
 *    candidate_review_flags row with that sync_id), never inserted/updated
 *    by it.
 *  - C900104: control — inserted by the DECOY sync, untouched by the
 *    target sync in any way. Must never appear in the target sync's filter.
 *
 * DESTRUCTIVE — only run against a throwaway/test database, never prod.
 * Run: npx tsx scripts/verify-candidate-sync-filter.ts
 */
import { closeDbClient, getDbClient } from "../src/lib/persistence/db-client";
import {
  queryCandidateMasterSheetPage,
  type CandidateMasterSheetQuery,
} from "../src/services/persistence/candidate-master-sheet-postgres";

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
}

function check(results: TestResult[], name: string, pass: boolean, detail?: string) {
  results.push({ name, status: pass ? "PASS" : "FAIL", detail });
}

const BASE_QUERY: Omit<CandidateMasterSheetQuery, "syncFilter" | "columnFilters"> & {
  columnFilters: Record<string, string[]>;
} = {
  page: 1,
  pageSize: 500,
  columnFilters: {},
  textFilters: {},
  dateFilters: {},
  highlightFilters: [],
};

async function main() {
  const sql = getDbClient();
  const results: TestResult[] = [];
  const cids = ["C900101", "C900102", "C900103", "C900104"];

  try {
    // --- seed ---
    const [targetSync] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, finished_at, result, source_filename, triggered_by)
      VALUES (NOW(), NOW(), 'partial', 'verify-sync-filter-target.xlsx', 'verify-script')
      RETURNING id
    `;
    const [decoySync] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, finished_at, result, source_filename, triggered_by)
      VALUES (NOW(), NOW(), 'success', 'verify-sync-filter-decoy.xlsx', 'verify-script')
      RETURNING id
    `;
    // candidate_sync_history.id is BIGSERIAL; postgres.js returns bigint
    // columns as strings by default — convert explicitly (mirrors
    // candidate-sync-job.ts's own handling of the same RETURNING id).
    const targetSyncId = Number(targetSync.id);
    const decoySyncId = Number(decoySync.id);

    async function seedRow(cid: string, insertedSyncId: number | null, status: string) {
      await sql`
        INSERT INTO candidate_master (
          cid, name, gender, contact_number, date_of_upload, submitter, customer,
          job_requisition_id, primary_skills, job_management_level, market,
          client_spoc, status, submitted_date, submission_comments, email,
          last_touched_at, inserted_sync_id
        ) VALUES (
          ${cid}, ${"Verify " + cid}, '-', '9999999999', '01/01/2026', '-', '-',
          'JR-1', '-', '-', '-', '-', ${status}, '-', '-', '-',
          NOW(), ${insertedSyncId}
        )
      `;
    }

    await seedRow(cids[0], targetSyncId, "Active"); // inserted by target sync
    await seedRow(cids[1], decoySyncId, "Active"); // pre-existing (as far as target sync is concerned), will be "updated" by target sync
    await seedRow(cids[2], decoySyncId, "Active"); // pre-existing, will be "flagged" by target sync
    await seedRow(cids[3], decoySyncId, "Inactive"); // control — decoy sync only, never touched by target sync

    await sql`
      INSERT INTO candidate_sync_changes (sync_id, cid, field_name, old_value, new_value)
      VALUES (${targetSyncId}, ${cids[1]}, 'status', 'Inactive', 'Active')
    `;
    await sql`
      INSERT INTO candidate_review_flags (sync_id, cid, reason, detail)
      VALUES (${targetSyncId}, ${cids[2]}, 'missing_job_requisition_id', '{}'::jsonb)
    `;

    // --- test 1: filtering by the target sync returns exactly the 3 touched CIDs ---
    const targetResult = await queryCandidateMasterSheetPage({
      ...BASE_QUERY,
      syncFilter: targetSyncId,
    });
    const targetCids = new Set(targetResult.rows.map((r) => r["Candidate ID"]));
    check(
      results,
      "target sync filter returns exactly {inserted, updated, flagged} CIDs (3 rows)",
      targetCids.size === 3 &&
        targetCids.has(cids[0]) &&
        targetCids.has(cids[1]) &&
        targetCids.has(cids[2]) &&
        !targetCids.has(cids[3]),
      `got: ${[...targetCids].sort().join(", ")}`
    );

    // --- test 2: the inserted-only row (no changes/flags rows) is NOT silently dropped ---
    check(
      results,
      "insert-only row (no candidate_sync_changes/candidate_review_flags row) is included",
      targetCids.has(cids[0]),
      `inserted_sync_id predicate ${targetCids.has(cids[0]) ? "worked" : "FAILED — the #3 gap is back"}`
    );

    // --- test 3: decoy sync's filter returns its own inserts, none of the target's touches ---
    const decoyResult = await queryCandidateMasterSheetPage({
      ...BASE_QUERY,
      syncFilter: decoySyncId,
    });
    const decoyCids = new Set(decoyResult.rows.map((r) => r["Candidate ID"]));
    check(
      results,
      "decoy sync filter returns its own 3 inserts (C900102/103/104), not the target-sync-only row",
      decoyCids.size === 3 &&
        decoyCids.has(cids[1]) &&
        decoyCids.has(cids[2]) &&
        decoyCids.has(cids[3]) &&
        !decoyCids.has(cids[0]),
      `got: ${[...decoyCids].sort().join(", ")}`
    );

    // --- test 4: syncFilter composes (ANDs) with an existing column filter ---
    const andedResult = await queryCandidateMasterSheetPage({
      ...BASE_QUERY,
      syncFilter: targetSyncId,
      columnFilters: { Status: ["Active"] },
    });
    const andedCids = new Set(andedResult.rows.map((r) => r["Candidate ID"]));
    check(
      results,
      "syncFilter ANDs with an existing column filter (Status=Active keeps all 3 — they're all Active)",
      andedCids.size === 3,
      `got: ${[...andedCids].sort().join(", ")}`
    );

    const andedResultInactive = await queryCandidateMasterSheetPage({
      ...BASE_QUERY,
      syncFilter: targetSyncId,
      columnFilters: { Status: ["Inactive"] },
    });
    check(
      results,
      "syncFilter ANDs with an existing column filter (Status=Inactive excludes all 3 target-sync rows)",
      andedResultInactive.rows.length === 0,
      `got: ${andedResultInactive.rows.length} row(s)`
    );

    // --- test 5: no syncFilter set → all 4 seeded rows visible (unfiltered) ---
    const unfilteredResult = await queryCandidateMasterSheetPage({
      ...BASE_QUERY,
      syncFilter: null,
      columnFilters: { "Job Requisition ID": ["JR-1"] },
    });
    const unfilteredCids = new Set(unfilteredResult.rows.map((r) => r["Candidate ID"]));
    check(
      results,
      "no syncFilter → all 4 seeded rows visible",
      cids.every((c) => unfilteredCids.has(c)),
      `got: ${[...unfilteredCids].sort().join(", ")}`
    );
  } finally {
    // --- cleanup ---
    await sql`DELETE FROM candidate_review_flags WHERE cid = ANY(${cids})`;
    await sql`DELETE FROM candidate_sync_changes WHERE cid = ANY(${cids})`;
    await sql`DELETE FROM candidate_master WHERE cid = ANY(${cids})`;
    await sql`DELETE FROM candidate_sync_history WHERE source_filename IN ('verify-sync-filter-target.xlsx', 'verify-sync-filter-decoy.xlsx')`;
  }

  console.log("\n=== Results ===");
  for (const r of results) {
    console.log(`[${r.status}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  const failed = results.filter((r) => r.status === "FAIL");
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("FATAL:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDbClient());
