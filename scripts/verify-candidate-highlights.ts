/**
 * C9 validation — Candidate Master Sheet highlighting (green changed-cell,
 * row-level duplicate-name-mismatch, amber per-field review flags).
 *
 * Runs two sequential syncs against a throwaway DB with a synthetic sheet,
 * then queries `queryCandidateMasterSheetPage` (the same function the real
 * API route calls) and asserts on the returned `highlights` object —
 * end-to-end through the exact layer the UI consumes, not just the raw
 * read-candidate-highlights.ts queries in isolation.
 *
 * Specifically proves the "most recent per issue" rule from
 * candidate-sync-engine.ts's doc comment: after a second sync that changes
 * a DIFFERENT field than the first, only the second sync's field shows
 * green (not both, not the first sync's field) — and after re-firing the
 * same JR conflict a second time, exactly 2 field flags still show (not 4
 * accumulated), while the raw candidate_review_flags table still holds all
 * 4 rows (append-only history preserved, only the display is filtered).
 *
 * DESTRUCTIVE — writes to candidate_master / candidate_sync_history /
 * candidate_sync_changes / candidate_review_flags / lateral_master /
 * executive_master. Throwaway/test DB only.
 *
 * Run: npx tsx scripts/verify-candidate-highlights.ts
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
    firstName: "",
    middleName: "-",
    lastName: "",
    email: "-",
    mobile: "-",
    gender: "-",
    submitter: "-",
    customer: "-",
    // Non-blank but nonexistent by default so ordinary rows don't
    // incidentally trip missing_job_requisition_id (migration 018) —
    // resolveCandidateAutoFetchFields treats "not found" identically to
    // "blank" for every field value, so this changes nothing else.
    clientSubmissionJr: "TEST-HL-JR-DEFAULT",
    customerJobTitle: "-",
    market: "-",
    clientSpoc: "-",
    status: "-",
    submittedDate: "-",
    reasonForRejection: "-",
    submissionComments: "-",
    ...partial,
  };
}

const TEST_CIDS = [
  "C90000101",
  "C90000102",
  "C90000103",
  "C90000104",
  "C90000105",
  "9000000097",
  "9000000098",
  "TEST-HL-LEGACY-UNCLEAN",
];

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

    // -- Seed lateral_master / executive_master for the JR conflict scenario --
    await sql`
      INSERT INTO lateral_master (job_requisition_id, primary_skills, job_management_level, market_map, poc)
      VALUES ('TEST-HL-JR', 'Skill Shared', '8-Associate Manager', 'Enterprise Platforms', 'Lateral SPOC')
      ON CONFLICT (job_requisition_id) DO NOTHING
    `;
    await sql`
      INSERT INTO executive_master (job_requisition_id, primary_skills, job_management_level, market_map)
      VALUES ('TEST-HL-JR', 'Skill Shared', '7-Manager', 'RP Wide')
      ON CONFLICT (job_requisition_id) DO NOTHING
    `;

    // -- Seed pre-existing candidate_master rows (so the duplicate-mismatch
    //    and changed-field scenarios have a real row to highlight) --
    await sql`
      INSERT INTO candidate_master (
        cid, name, gender, contact_number, date_of_upload, submitter, customer,
        job_requisition_id, primary_skills, job_management_level, market,
        client_spoc, status, submitted_date, submission_comments, email
      ) VALUES
        ('C90000101', 'Changed Person', 'Male', '9000000001', '01/01/2026', 'Sub', 'Cust',
         'TEST-HL-JR-DEFAULT', 'Skill', '-', 'Mkt', '-', 'Old Status', '01/01/2026', 'Comments', 'a@example.com'),
        ('C90000104', 'Dup Original Name', 'Male', '9000000002', '01/01/2026', 'Sub', 'Cust',
         '-', 'Skill', '-', 'Mkt', '-', 'Status', '01/01/2026', 'Comments', 'b@example.com'),
        ('TEST-HL-LEGACY-UNCLEAN', 'Legacy Unclean Person', 'Male', '098-invalid', '01/01/2026', 'Sub', 'Cust',
         '-', 'Skill', '-', 'Mkt', '-', 'Status', '01/01/2026', 'Comments', 'c@example.com'),
        ('9000000097', 'Retro Invalid Cid Person', 'Male', '9000000099', '01/01/2026', 'Sub', 'Cust',
         '-', 'Skill', '-', 'Mkt', '-', 'Status', '01/01/2026', 'Comments', 'd@example.com')
    `;

    // -- Sync 1 history row --
    const [historyRow1] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, result, source_filename)
      VALUES (NOW(), 'success', 'verify-candidate-highlights-sync-1')
      RETURNING id
    `;
    const syncId1 = historyRow1.id;

    // -- A synthetic legacy_contact_number_unclean flag (normally written
    //    only by the one-time C2 migration script, not the live sync engine)
    //    -- insert directly, reusing sync1's real history row for a valid FK --
    await sql`
      INSERT INTO candidate_review_flags (sync_id, cid, reason, detail)
      VALUES (${syncId1}, 'TEST-HL-LEGACY-UNCLEAN', 'legacy_contact_number_unclean', ${sql.json({ rowId: 1, raw: "098-invalid" })})
    `;

    // -- A synthetic invalid_candidate_id flag against a PRE-EXISTING row —
    //    mirrors the one-time retroactive backfill script's own write
    //    pattern (flag an already-inserted bad-CID row, never delete it) --
    await sql`
      INSERT INTO candidate_review_flags (sync_id, cid, reason, detail)
      VALUES (${syncId1}, '9000000097', 'invalid_candidate_id', ${sql.json({ rowId: 1, name: "Retro Invalid Cid Person", rawCid: "9000000097" })})
    `;

    const sheet1: CandidateOorwinParsedRow[] = [
      // Status changes on an existing row.
      row({
        sheetRowNumber: 1,
        cid: "C90000101",
        firstName: "Changed",
        lastName: "Person",
        mobile: "9000000001",
        email: "a@example.com",
        gender: "Male",
        submitter: "Sub",
        customer: "Cust",
        customerJobTitle: "Skill",
        market: "Mkt",
        status: "New Status 1",
        submittedDate: "01/01/2026",
        submissionComments: "Comments",
      }),
      // New candidate, JR conflict on job_management_level + market simultaneously.
      row({
        sheetRowNumber: 2,
        cid: "C90000102",
        firstName: "Jr",
        lastName: "Conflict",
        mobile: "9000000003",
        email: "jr@example.com",
        clientSubmissionJr: "TEST-HL-JR",
      }),
      // New candidate, unresolvable mobile.
      row({
        sheetRowNumber: 3,
        cid: "C90000103",
        firstName: "Unclean",
        lastName: "Mobile",
        mobile: "9000000004/9000000005",
        email: "unclean@example.com",
      }),
      // Duplicate-name-mismatch pair for an EXISTING cid — both quarantined,
      // the existing row stays untouched, but a flag is written against it.
      row({
        sheetRowNumber: 4,
        cid: "C90000104",
        firstName: "Name",
        lastName: "One",
        mobile: "9000000006",
      }),
      row({
        sheetRowNumber: 5,
        cid: "C90000104",
        firstName: "Totally",
        lastName: "Different",
        mobile: "9000000007",
      }),
      // Invalid CID format — quarantined, must show up as a row-level flag
      // if it's ever retroactively backfilled against an existing row (it
      // isn't here — this proves the flag-write path itself).
      row({
        sheetRowNumber: 6,
        cid: "9000000098",
        firstName: "Invalid",
        lastName: "CidFormat",
        mobile: "9000000008",
      }),
      // Valid CID, blank JR ID — must still insert, with a field flag.
      row({
        sheetRowNumber: 7,
        cid: "C90000105",
        firstName: "Missing",
        lastName: "Jr",
        mobile: "9000000009",
        clientSubmissionJr: "-",
      }),
    ];

    await runCandidateSync(sheet1, syncId1, sql);

    // -- Query through the real page layer (same function the API route calls) --
    const page1 = await queryCandidateMasterSheetPage(
      { page: 1, pageSize: 500, columnFilters: {}, textFilters: {}, dateFilters: {} },
      sql
    );
    const h1 = page1.highlights;

    check(
      results,
      "Sync 1: C90000101 shows 'Status' as a changed (green) cell",
      (h1.changedCellsByCid["C90000101"] ?? []).includes("Status"),
      JSON.stringify(h1.changedCellsByCid["C90000101"])
    );
    check(
      results,
      "Sync 1: C90000102 has exactly 2 field flags (Job Management Level + Market)",
      (h1.fieldFlagsByCid["C90000102"] ?? []).length === 2,
      JSON.stringify(h1.fieldFlagsByCid["C90000102"])
    );
    check(
      results,
      "Sync 1: JR conflict flags cover exactly {Job Management Level, Market}, both reason=jr_id_conflict",
      new Set((h1.fieldFlagsByCid["C90000102"] ?? []).map((f) => f.header)).size === 2 &&
        (h1.fieldFlagsByCid["C90000102"] ?? []).every((f) => f.reason === "jr_id_conflict") &&
        ["Job Management Level", "Market"].every((h) =>
          (h1.fieldFlagsByCid["C90000102"] ?? []).some((f) => f.header === h)
        )
    );
    const jmlFlag = (h1.fieldFlagsByCid["C90000102"] ?? []).find(
      (f) => f.header === "Job Management Level"
    );
    check(
      results,
      "Sync 1: Job Management Level conflict detail has correct lateral/executive values",
      jmlFlag?.detail.lateralValue === "8-Associate Manager" &&
        jmlFlag?.detail.executiveValue === "7-Manager",
      JSON.stringify(jmlFlag?.detail)
    );
    check(
      results,
      "Sync 1: C90000103 has exactly 1 field flag on Contact Number, reason=unclean_contact_number",
      (h1.fieldFlagsByCid["C90000103"] ?? []).length === 1 &&
        h1.fieldFlagsByCid["C90000103"]?.[0]?.header === "Contact Number" &&
        h1.fieldFlagsByCid["C90000103"]?.[0]?.reason === "unclean_contact_number" &&
        h1.fieldFlagsByCid["C90000103"]?.[0]?.detail.raw === "9000000004/9000000005",
      JSON.stringify(h1.fieldFlagsByCid["C90000103"])
    );
    check(
      results,
      "Sync 1: C90000104 is in duplicateFlagCids with reason=duplicate_name_mismatch (row-level highlight)",
      h1.duplicateFlagCids["C90000104"] === "duplicate_name_mismatch"
    );
    check(
      results,
      "Sync 1: C90000104's own field values are untouched (quarantine excluded it from processing)",
      (await sql`SELECT name FROM candidate_master WHERE cid = 'C90000104'`)[0]?.name === "Dup Original Name"
    );
    check(
      results,
      "legacy_contact_number_unclean flag (inserted directly, mirroring the C2 migration script) shows on Contact Number too",
      (h1.fieldFlagsByCid["TEST-HL-LEGACY-UNCLEAN"] ?? []).some(
        (f) => f.header === "Contact Number" && f.reason === "legacy_contact_number_unclean"
      )
    );

    // -- Invalid CID (new live-sync row): quarantined, never enters candidate_master, so it's invisible to this page query --
    check(
      results,
      "Sync 1: brand-new invalid-CID row (9000000098) never inserted into candidate_master",
      (await sql`SELECT 1 FROM candidate_master WHERE cid = '9000000098'`).length === 0
    );
    check(
      results,
      "Sync 1: brand-new invalid-CID row still gets an 'invalid_candidate_id' review flag written",
      (
        await sql`SELECT reason FROM candidate_review_flags WHERE cid = '9000000098'`
      ).some((r: { reason: string }) => r.reason === "invalid_candidate_id")
    );

    // -- Invalid CID (retroactively flagged, PRE-EXISTING row): row already
    //    exists in candidate_master, so unlike the brand-new case above, the
    //    flag DOES surface as a row-level highlight — this is the backfill
    //    scenario the retroactive-flag script relies on for visibility.
    check(
      results,
      "Sync 1: retroactively-flagged pre-existing row (9000000097) shows in duplicateFlagCids with reason=invalid_candidate_id",
      h1.duplicateFlagCids["9000000097"] === "invalid_candidate_id"
    );

    // -- Missing Job Requisition ID: still inserted, with a field flag on 'Job Requisition ID' --
    check(
      results,
      "Sync 1: C90000105 (blank JR) is inserted normally",
      (await sql`SELECT 1 FROM candidate_master WHERE cid = 'C90000105'`).length === 1
    );
    check(
      results,
      "Sync 1: C90000105 has exactly 1 field flag, on 'Job Requisition ID', reason=missing_job_requisition_id",
      (h1.fieldFlagsByCid["C90000105"] ?? []).length === 1 &&
        h1.fieldFlagsByCid["C90000105"]?.[0]?.header === "Job Requisition ID" &&
        h1.fieldFlagsByCid["C90000105"]?.[0]?.reason === "missing_job_requisition_id",
      JSON.stringify(h1.fieldFlagsByCid["C90000105"])
    );

    // -- Sync 2: change a DIFFERENT field, re-fire the SAME JR conflict --
    const [historyRow2] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, result, source_filename)
      VALUES (NOW(), 'success', 'verify-candidate-highlights-sync-2')
      RETURNING id
    `;
    const syncId2 = historyRow2.id;

    const sheet2: CandidateOorwinParsedRow[] = [
      // Same status as sync 1 left it, but Customer changes this time.
      row({
        sheetRowNumber: 1,
        cid: "C90000101",
        firstName: "Changed",
        lastName: "Person",
        mobile: "9000000001",
        email: "a@example.com",
        gender: "Male",
        submitter: "Sub",
        customer: "New Customer",
        customerJobTitle: "Skill",
        market: "Mkt",
        status: "New Status 1",
        submittedDate: "01/01/2026",
        submissionComments: "Comments",
      }),
      // Same JR conflict, same underlying lateral/executive values — fires again.
      row({
        sheetRowNumber: 2,
        cid: "C90000102",
        firstName: "Jr",
        lastName: "Conflict",
        mobile: "9000000003",
        email: "jr@example.com",
        clientSubmissionJr: "TEST-HL-JR",
      }),
    ];

    await runCandidateSync(sheet2, syncId2, sql);

    const page2 = await queryCandidateMasterSheetPage(
      { page: 1, pageSize: 500, columnFilters: {}, textFilters: {}, dateFilters: {} },
      sql
    );
    const h2 = page2.highlights;

    check(
      results,
      "Sync 2: C90000101 now shows ONLY 'Customer' as changed — NOT 'Status' (sync 1's change doesn't leak forward)",
      (h2.changedCellsByCid["C90000101"] ?? []).includes("Customer") &&
        !(h2.changedCellsByCid["C90000101"] ?? []).includes("Status"),
      JSON.stringify(h2.changedCellsByCid["C90000101"])
    );
    check(
      results,
      "Sync 2: C90000102 still shows exactly 2 field flags (NOT 4 accumulated) after the conflict recurred",
      (h2.fieldFlagsByCid["C90000102"] ?? []).length === 2,
      JSON.stringify(h2.fieldFlagsByCid["C90000102"])
    );
    const rawFlagCount = Number(
      (
        await sql<{ c: string }[]>`
          SELECT COUNT(*)::text AS c FROM candidate_review_flags
          WHERE cid = 'C90000102' AND reason = 'jr_id_conflict'
        `
      )[0]?.c ?? "0"
    );
    check(
      results,
      "Append-only history preserved: candidate_review_flags physically holds all 4 rows (2 per sync x 2 syncs), even though only 2 are shown",
      rawFlagCount === 4,
      `got ${rawFlagCount}`
    );

    // -- Prove the naive DISTINCT ON (cid, reason) approach would have been wrong --
    const naiveRows = await sql<{ cid: string; reason: string }[]>`
      SELECT DISTINCT ON (cid, reason) cid, reason
      FROM candidate_review_flags
      WHERE cid = 'C90000102' AND reason = 'jr_id_conflict'
      ORDER BY cid, reason, created_at DESC
    `;
    check(
      results,
      "Naive DISTINCT ON (cid, reason) would wrongly collapse the 2 simultaneous field conflicts down to 1 row (proves why MAX(sync_id)+join-back is required)",
      naiveRows.length === 1,
      `naive query returned ${naiveRows.length} row(s); the correct query (used by the app) returns 2`
    );

    // -- Untouched candidate: no highlight of any kind --
    check(
      results,
      "TEST-HL-LEGACY-UNCLEAN's Contact Number flag persists across sync 2 (never re-fired, still 'latest' since nothing superseded it)",
      (h2.fieldFlagsByCid["TEST-HL-LEGACY-UNCLEAN"] ?? []).some((f) => f.header === "Contact Number")
    );

    // -- Pagination scoping: highlights are only computed for CIDs on the returned page --
    const scoped = await queryCandidateMasterSheetPage(
      {
        page: 1,
        pageSize: 20,
        columnFilters: { "Candidate ID": ["C90000101"] },
        textFilters: {},
        dateFilters: {},
      },
      sql
    );
    check(
      results,
      "Scoped query (filtered to only C90000101) does not leak C90000102's flags into the response",
      scoped.highlights.fieldFlagsByCid["C90000102"] === undefined
    );
    check(
      results,
      "Scoped query still includes C90000101's own highlight",
      (scoped.highlights.changedCellsByCid["C90000101"] ?? []).includes("Customer")
    );

    // -- cleanup --
    await sql`DELETE FROM candidate_review_flags WHERE cid = ANY(${TEST_CIDS})`;
    await sql`DELETE FROM candidate_sync_changes WHERE cid = ANY(${TEST_CIDS})`;
    await sql`DELETE FROM candidate_master WHERE cid = ANY(${TEST_CIDS})`;
    await sql`DELETE FROM candidate_sync_history WHERE id IN (${syncId1}, ${syncId2})`;
    await sql`DELETE FROM lateral_master WHERE job_requisition_id = 'TEST-HL-JR'`;
    await sql`DELETE FROM executive_master WHERE job_requisition_id = 'TEST-HL-JR'`;
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
