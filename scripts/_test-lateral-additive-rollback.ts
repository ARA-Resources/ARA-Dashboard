/**
 * TEST-ONLY harness — proves `insertNewRowsInTransaction` (the exact,
 * unmodified function `--execute` calls in
 * `lateral-master-additive-import.ts`) rolls back the ENTIRE transaction,
 * across batches, when one row fails partway through.
 *
 * ISOLATION: this script does NOT touch, reimplement, or weaken the real
 * script's skip-existing filter in any way. It imports the real
 * `validateAndPartitionRows` (to build a genuine, fully-valid row list from
 * the real source file, via the real header-mapping/validation logic) and
 * the real `insertNewRowsInTransaction` (the real transactional writer).
 * The ONLY thing this script does differently from a real --execute run is
 * build its own test-only `rowsToInsert` array in memory — by taking a
 * slice of the real valid "would insert" rows and deliberately duplicating
 * one row's job_requisition_id into a later batch BEFORE calling the real
 * insert function. The real CLI's existing-ID skip filter in
 * `lateral-master-additive-import.ts`'s `main()` is never invoked by this
 * script at all (this script never calls `main()`), so it is impossible for
 * this test to have touched or weakened it.
 *
 * Usage:
 *   POSTGRES_URL=<throwaway-db-url> npx tsx scripts/_test-lateral-additive-rollback.ts --file <path.xlsm>
 *
 * Intended to run ONLY against a throwaway/test database — never prod.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { getDbClient, closeDbClient } from "../src/lib/persistence/db-client";
import { mapMasterSheetHeaders, LATERAL_MASTER_SHEET_NAME } from "../src/services/lateral-processing/lateral-master-pg-backfill";
import { extractMasterSheetRows } from "./import-lateral-master-to-postgres";
import {
  validateAndPartitionRows,
  insertNewRowsInTransaction,
} from "./lateral-master-additive-import";

const BATCH_SIZE = 500;
const TEST_BATCH_ROWS = 2500; // 5 batches at BATCH_SIZE=500 — failure injected into batch 4
const CORRUPT_AT_INDEX = 1600; // inside batch 4 (rows 1500-1999), well past batch 1-3 commits-within-tx

async function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--file");
  const filePath = fileIdx >= 0 ? args[fileIdx + 1] : undefined;
  if (!filePath || !existsSync(path.resolve(filePath))) {
    console.error("Usage: tsx scripts/_test-lateral-additive-rollback.ts --file <path.xlsm>");
    process.exitCode = 1;
    return;
  }
  const resolvedPath = path.resolve(filePath);

  console.log("========== ROLLBACK TEST (throwaway DB only) ==========");
  console.log(`POSTGRES_URL host hint: ${(process.env.POSTGRES_URL || "").split("@")[1] || "(unset)"}`);
  console.log(`Source file: ${resolvedPath}\n`);

  const extracted = await extractMasterSheetRows(resolvedPath, LATERAL_MASTER_SHEET_NAME);
  const mapping = mapMasterSheetHeaders(extracted.headers);
  if (!mapping.ok) {
    console.error("Header mapping failed:\n" + mapping.message);
    process.exitCode = 1;
    return;
  }

  // Real validation, real function, unmodified.
  const { validRows } = validateAndPartitionRows(extracted.headers, extracted.rows, mapping);

  const sql = getDbClient();
  try {
    const existingRows = await sql<{ job_requisition_id: string }[]>`
      SELECT job_requisition_id FROM lateral_master
    `;
    const existingIds = new Set(existingRows.map((r) => r.job_requisition_id));
    const toInsert = validRows.filter((r) => !existingIds.has(r.job_requisition_id));

    const countBefore = Number(
      (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_master`)[0]?.c ?? "0"
    );
    console.log(`lateral_master count BEFORE test: ${countBefore}`);
    console.log(`Real valid "would insert" rows available to build the test batch from: ${toInsert.length}\n`);

    if (toInsert.length < TEST_BATCH_ROWS) {
      console.error(`Not enough real new rows (${toInsert.length}) to build a ${TEST_BATCH_ROWS}-row, 5-batch test. Aborting.`);
      process.exitCode = 1;
      return;
    }

    // Test-only in-memory row list — a real slice of real valid rows, with
    // one deliberate corruption spliced in. Nothing here touches the main
    // script's own existing-ID filter or validation logic.
    const testBatch = toInsert.slice(0, TEST_BATCH_ROWS).map((r) => ({ ...r }));
    const originalId = testBatch[CORRUPT_AT_INDEX].job_requisition_id;
    const duplicateOf = testBatch[0].job_requisition_id;
    testBatch[CORRUPT_AT_INDEX] = { ...testBatch[CORRUPT_AT_INDEX], job_requisition_id: duplicateOf };

    console.log(`Test batch size: ${testBatch.length} rows across ${Math.ceil(testBatch.length / BATCH_SIZE)} batches of ${BATCH_SIZE}.`);
    console.log(
      `Deliberate corruption: row at index ${CORRUPT_AT_INDEX} (batch ${Math.floor(CORRUPT_AT_INDEX / BATCH_SIZE) + 1}, ` +
        `originally "${originalId}") had its job_requisition_id overwritten to "${duplicateOf}" — ` +
        `a duplicate of row index 0 (batch 1), which will already be committed-within-transaction by the time batch 4 runs.`
    );
    console.log("This violates the lateral_master_pkey PRIMARY KEY constraint. Running insertNewRowsInTransaction()...\n");

    let threw: unknown = null;
    try {
      await insertNewRowsInTransaction(sql, testBatch, BATCH_SIZE);
    } catch (err) {
      threw = err;
    }

    const countAfter = Number(
      (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_master`)[0]?.c ?? "0"
    );

    console.log("-- Result --");
    if (threw) {
      console.log("INSERT THREW (expected):");
      console.log("  " + (threw instanceof Error ? threw.message : String(threw)));
    } else {
      console.log("INSERT DID NOT THROW — unexpected, the test's corruption should have violated the PK constraint.");
    }
    console.log(`\nlateral_master count AFTER test: ${countAfter} (before was ${countBefore})`);

    // Spot-check: none of the first 3 batches' rows (which succeeded before
    // the failing batch 4) should be present either — proving the ROLLBACK
    // covered already-applied batches, not just skipped the bad row.
    const batch1SampleIds = testBatch.slice(0, 3).map((r) => r.job_requisition_id);
    const leaked = await sql<{ job_requisition_id: string }[]>`
      SELECT job_requisition_id FROM lateral_master WHERE job_requisition_id = ANY(${batch1SampleIds})
    `;

    const pass = countAfter === countBefore && leaked.length === 0 && Boolean(threw);
    console.log(`Batch-1 sample rows (should NOT be present): found ${leaked.length} of ${batch1SampleIds.length} leaked into the table.`);
    console.log(`\n${pass ? "PASS" : "FAIL"}: full-transaction rollback ${pass ? "confirmed" : "NOT confirmed"} — count unchanged AND no partial batch data leaked.`);
    console.log("========== END ROLLBACK TEST ==========");
    if (!pass) process.exitCode = 1;
  } finally {
    await closeDbClient();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
