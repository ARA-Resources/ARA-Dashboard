/**
 * C5 validation — the core compare/update sync engine.
 *
 * Two parts:
 *  1. Real-data dedupe test: parses the actual Oorwin sample file and
 *     confirms the two naturally-occurring duplicate-CID-mismatch pairs
 *     found in it (C27803646, C27788750) are correctly quarantined by the
 *     pure `planCandidateSheetDedupe` — no DB involved.
 *  2. Synthetic end-to-end test: seeds a throwaway candidate_master +
 *     lateral_master/executive_master, runs `runCandidateSync` against a
 *     hand-built incoming sheet covering every scenario (new, changed,
 *     unchanged, untouched, duplicate-same-name-collapse, JR conflict,
 *     JR single-table, JR not-found, blank CID, mobile normalize/fallback,
 *     comments primary/fallback), then asserts against real DB state.
 *
 * DESTRUCTIVE — writes to candidate_master / candidate_sync_history /
 * candidate_sync_changes / candidate_review_flags / lateral_master /
 * executive_master. Only ever run this against a throwaway/test database,
 * never prod.
 *
 * Run: npx tsx scripts/verify-candidate-sync-engine.ts [pathToXlsFile]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { closeDbClient, getDbClient } from "../src/lib/persistence/db-client";
import { parseCandidateOorwinWorkbook } from "../src/services/candidate-processing/candidate-oorwin-parser";
import {
  planCandidateSheetDedupe,
  runCandidateSync,
} from "../src/services/candidate-processing/candidate-sync-engine";
import type { CandidateOorwinParsedRow } from "../src/services/candidate-processing/candidate-oorwin-parser";
import { combineCandidateName } from "../src/services/candidate-processing/candidate-field-utils";

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
}

function check(results: TestResult[], name: string, pass: boolean, detail?: string) {
  results.push({ name, status: pass ? "PASS" : "FAIL", detail });
}

function row(partial: Partial<CandidateOorwinParsedRow> & { sheetRowNumber: number; cid: string }): CandidateOorwinParsedRow {
  return {
    firstName: "",
    middleName: "-",
    lastName: "",
    email: "-",
    mobile: "-",
    gender: "-",
    submitter: "-",
    customer: "-",
    clientSubmissionJr: "-",
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

async function main() {
  const results: TestResult[] = [];

  // ===== Part 1: real-data dedupe test (no DB) =====
  const filePath =
    process.argv[2] ||
    path.join(process.cwd(), "data", "excel", "ACCI Candidate Master Tracker Test - Anurag Shah-4.xls");
  const buffer = await fs.readFile(filePath);
  const parsed = parseCandidateOorwinWorkbook(buffer);
  if (!parsed.ok) throw new Error(`Real sample file failed to parse: ${parsed.message}`);

  const realDedupe = planCandidateSheetDedupe(parsed.rows);
  const groupsByType = new Map(realDedupe.quarantined.map((g) => [g.cid, g]));

  check(
    results,
    "Real file: exactly 2 quarantine groups found (the 2 known duplicate-name-mismatch pairs)",
    realDedupe.quarantined.length === 2,
    `got ${realDedupe.quarantined.length}: [${realDedupe.quarantined.map((g) => g.cid).join(", ")}]`
  );
  check(
    results,
    "Real file: C27803646 (Nitu Kumari vs Yogesh Bhati) quarantined with 2 members",
    groupsByType.get("C27803646")?.members.length === 2
  );
  check(
    results,
    "Real file: C27788750 (Subhashree Panda vs SUSHMA NAIK) quarantined with 2 members",
    groupsByType.get("C27788750")?.members.length === 2
  );
  check(
    results,
    "Real file: 60 total rows - 4 quarantined rows = 56 survivors",
    realDedupe.survivors.length === 56,
    `got ${realDedupe.survivors.length}`
  );

  // ===== Part 2: synthetic end-to-end test against a throwaway DB =====
  const sql = getDbClient();
  try {
    // Guard: refuse to run against anything that looks like real data.
    const existingCount = Number(
      (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_master`)[0]?.c ?? "0"
    );
    if (existingCount > 100) {
      throw new Error(
        `candidate_master has ${existingCount} rows — refusing to run this destructive test against what looks like real data. Point POSTGRES_URL at a throwaway database.`
      );
    }

    // -- Seed lateral_master / executive_master for auto-fetch scenarios --
    await sql`
      INSERT INTO lateral_master (job_requisition_id, primary_skills, job_management_level, market_map, poc)
      VALUES
        ('TEST-JR-CONFLICT', 'Skill Shared', '8-Associate Manager', 'Enterprise Platforms', 'Lateral SPOC'),
        ('TEST-JR-LATERAL-ONLY', 'Lateral Only Skill', '9-Team Lead', 'Americas', 'Lateral Only SPOC')
      ON CONFLICT (job_requisition_id) DO NOTHING
    `;
    await sql`
      INSERT INTO executive_master (job_requisition_id, primary_skills, job_management_level, market_map)
      VALUES ('TEST-JR-CONFLICT', 'Skill Shared', '7-Manager', 'RP Wide')
      ON CONFLICT (job_requisition_id) DO NOTHING
    `;

    // -- Seed pre-existing candidate_master rows --
    await sql`
      INSERT INTO candidate_master (
        cid, name, gender, contact_number, date_of_upload, submitter, customer,
        job_requisition_id, primary_skills, job_management_level, market,
        client_spoc, status, submitted_date, submission_comments, email
      ) VALUES
        ('TEST-EXISTING-1', 'Existing One', 'Male', '9000000001', '01/01/2026', 'Old Submitter', 'Old Customer',
         '-', 'Old Skill', '-', 'Old Market', '-', 'Old Status', '01/01/2026', 'Old Comments', 'old@example.com'),
        ('TEST-EXISTING-2', 'Existing Two', 'Female', '9000000006', '01/01/2026', 'Same Submitter', 'Same Customer',
         '-', 'Same Skill', '-', 'Same Market', '-', 'Same Status', '05/01/2026', 'Same Comments', 'same@example.com'),
        ('TEST-UNTOUCHED', 'Untouched Person', 'Male', '9000000007', '01/01/2026', 'Untouched Submitter', 'Untouched Customer',
         '-', 'Untouched Skill', '-', 'Untouched Market', '-', 'Untouched Status', '01/01/2026', 'Untouched Comments', 'untouched@example.com')
    `;
    const untouchedBefore = (await sql`SELECT * FROM candidate_master WHERE cid = 'TEST-UNTOUCHED'`)[0];

    // -- Create a real candidate_sync_history row to get a real sync_id --
    const [historyRow] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, result, source_filename)
      VALUES (NOW(), 'success', 'verify-candidate-sync-engine-test')
      RETURNING id
    `;
    const syncId = historyRow.id;

    // -- Build the synthetic incoming sheet --
    const sheet: CandidateOorwinParsedRow[] = [
      // 1. New candidate, clean mobile with 91 country code.
      row({
        sheetRowNumber: 1,
        cid: "TEST-NEW-CLEAN-MOBILE",
        firstName: "New",
        lastName: "Clean",
        mobile: "919000000002",
        email: "new1@example.com",
      }),
      // 2. New candidate, mobile with embedded space.
      row({
        sheetRowNumber: 2,
        cid: "TEST-NEW-MESSY-MOBILE",
        firstName: "New",
        lastName: "Messy",
        mobile: "90000 00003",
        email: "new2@example.com",
      }),
      // 3. New candidate, unresolvable mobile (two numbers) — raw stored as-is.
      row({
        sheetRowNumber: 3,
        cid: "TEST-NEW-UNRESOLVABLE-MOBILE",
        firstName: "New",
        lastName: "Unresolvable",
        mobile: "9000000004/9000000005",
        email: "new3@example.com",
      }),
      // 4. Existing-1: only Status changes.
      row({
        sheetRowNumber: 4,
        cid: "TEST-EXISTING-1",
        firstName: "Existing",
        lastName: "One",
        mobile: "9000000001",
        email: "old@example.com",
        gender: "Male",
        submitter: "Old Submitter",
        customer: "Old Customer",
        customerJobTitle: "Old Skill",
        market: "Old Market",
        clientSpoc: "-",
        status: "New Status",
        submittedDate: "01/01/2026",
        submissionComments: "Old Comments",
      }),
      // 5. Existing-2: everything identical — true no-op.
      row({
        sheetRowNumber: 5,
        cid: "TEST-EXISTING-2",
        firstName: "Existing",
        lastName: "Two",
        mobile: "9000000006",
        email: "same@example.com",
        gender: "Female",
        submitter: "Same Submitter",
        customer: "Same Customer",
        customerJobTitle: "Same Skill",
        market: "Same Market",
        clientSpoc: "-",
        status: "Same Status",
        submittedDate: "05/01/2026",
        submissionComments: "Same Comments",
      }),
      // 6. JR conflict: management_level and market conflict, primary_skills agrees, client_spoc lateral-only.
      row({
        sheetRowNumber: 6,
        cid: "TEST-NEW-JR-CONFLICT",
        firstName: "New",
        lastName: "Conflict",
        mobile: "9000000008",
        email: "conflict@example.com",
        clientSubmissionJr: "TEST-JR-CONFLICT",
        customerJobTitle: "should-not-be-used",
        market: "should-not-be-used",
        clientSpoc: "should-not-be-used",
      }),
      // 7. JR found in lateral_master only.
      row({
        sheetRowNumber: 7,
        cid: "TEST-NEW-JR-LATERAL-ONLY",
        firstName: "New",
        lastName: "LateralOnly",
        mobile: "9000000009",
        email: "lateralonly@example.com",
        clientSubmissionJr: "TEST-JR-LATERAL-ONLY",
        customerJobTitle: "should-not-be-used",
        market: "should-not-be-used",
        clientSpoc: "should-not-be-used",
      }),
      // 8. JR not found anywhere — Oorwin fallback used.
      row({
        sheetRowNumber: 8,
        cid: "TEST-NEW-JR-NOT-FOUND",
        firstName: "New",
        lastName: "NotFound",
        mobile: "9000000010",
        email: "notfound@example.com",
        clientSubmissionJr: "TEST-JR-DOES-NOT-EXIST",
        customerJobTitle: "Fallback Skill From Oorwin",
        market: "Fallback Market From Oorwin",
        clientSpoc: "Fallback SPOC From Oorwin",
      }),
      // 9. Blank CID — must be skipped entirely.
      row({ sheetRowNumber: 9, cid: "-", firstName: "Blank", lastName: "Cid" }),
      // 10. Comments: primary present.
      row({
        sheetRowNumber: 10,
        cid: "TEST-NEW-COMMENTS-PRIMARY",
        firstName: "New",
        lastName: "CommentsPrimary",
        mobile: "9000000011",
        submissionComments: "Primary Comment",
        reasonForRejection: "should-not-be-used",
      }),
      // 11. Comments: primary blank, fallback used.
      row({
        sheetRowNumber: 11,
        cid: "TEST-NEW-COMMENTS-FALLBACK",
        firstName: "New",
        lastName: "CommentsFallback",
        mobile: "9000000012",
        submissionComments: "-",
        reasonForRejection: "Fallback Comment",
      }),
      // 12. Comments: both blank.
      row({
        sheetRowNumber: 12,
        cid: "TEST-NEW-COMMENTS-BOTH-BLANK",
        firstName: "New",
        lastName: "CommentsBothBlank",
        mobile: "9000000013",
        submissionComments: "-",
        reasonForRejection: "-",
      }),
      // 13 & 14. Duplicate CID within sheet, SAME name — last row wins.
      row({
        sheetRowNumber: 13,
        cid: "TEST-DUP-SAME",
        firstName: "Dup",
        lastName: "Same",
        mobile: "9000000014",
        status: "First Status",
      }),
      row({
        sheetRowNumber: 14,
        cid: "TEST-DUP-SAME",
        firstName: "Dup",
        lastName: "Same",
        mobile: "9000000014",
        status: "Second Status",
      }),
    ];

    const summary = await runCandidateSync(sheet, syncId, sql);

    check(results, "Summary: rowsInSheet matches sheet length", summary.rowsInSheet === sheet.length, `${summary.rowsInSheet}`);
    check(results, "Summary: skippedBlankCidCount === 1", summary.skippedBlankCidCount === 1, `${summary.skippedBlankCidCount}`);
    check(
      results,
      "Summary: insertedCount === 10 (10 genuinely new CIDs, dup-same-name collapses to 1)",
      summary.insertedCount === 10,
      `${summary.insertedCount}`
    );
    check(results, "Summary: updatedCount === 1 (TEST-EXISTING-1)", summary.updatedCount === 1, `${summary.updatedCount}`);
    check(results, "Summary: unchangedCount === 1 (TEST-EXISTING-2)", summary.unchangedCount === 1, `${summary.unchangedCount}`);
    check(
      results,
      "Summary: reviewFlagCount === 3 (2 JR conflict fields + 1 unclean mobile)",
      summary.reviewFlagCount === 3,
      `${summary.reviewFlagCount}`
    );

    const byCid = async (cid: string) => (await sql`SELECT * FROM candidate_master WHERE cid = ${cid}`)[0];

    const existing1 = await byCid("TEST-EXISTING-1");
    check(results, "TEST-EXISTING-1: status updated to 'New Status'", existing1?.status === "New Status");
    check(results, "TEST-EXISTING-1: unrelated field (customer) untouched", existing1?.customer === "Old Customer");
    check(results, "TEST-EXISTING-1: date_of_upload untouched (write-once)", existing1?.date_of_upload === "01/01/2026");
    check(results, "TEST-EXISTING-1: last_touched_at now set", existing1?.last_touched_at !== null);
    const changes1 = await sql`SELECT field_name FROM candidate_sync_changes WHERE cid = 'TEST-EXISTING-1' AND sync_id = ${syncId}`;
    check(
      results,
      "TEST-EXISTING-1: exactly one candidate_sync_changes row, for 'status'",
      changes1.length === 1 && changes1[0].field_name === "status",
      JSON.stringify(changes1.map((r: { field_name: string }) => r.field_name))
    );

    const existing2 = await byCid("TEST-EXISTING-2");
    check(results, "TEST-EXISTING-2: last_touched_at still null (true no-op)", existing2?.last_touched_at === null);
    const changes2 = await sql`SELECT * FROM candidate_sync_changes WHERE cid = 'TEST-EXISTING-2'`;
    check(results, "TEST-EXISTING-2: zero candidate_sync_changes rows written", changes2.length === 0);

    const untouchedAfter = await byCid("TEST-UNTOUCHED");
    check(
      results,
      "TEST-UNTOUCHED: row completely identical before/after (absent from sheet = true no-op)",
      JSON.stringify(untouchedBefore) === JSON.stringify(untouchedAfter)
    );

    const cleanMobile = await byCid("TEST-NEW-CLEAN-MOBILE");
    check(results, "New row: 91-prefixed mobile normalized to 10 digits", cleanMobile?.contact_number === "9000000002");

    const messyMobile = await byCid("TEST-NEW-MESSY-MOBILE");
    check(results, "New row: space-embedded mobile normalized", messyMobile?.contact_number === "9000000003");

    const unresolvableMobile = await byCid("TEST-NEW-UNRESOLVABLE-MOBILE");
    check(
      results,
      "New row: unresolvable mobile (two numbers) stored as raw text, not mangled/rejected",
      unresolvableMobile?.contact_number === "9000000004/9000000005",
      unresolvableMobile?.contact_number
    );
    const uncleanMobileFlags = await sql`
      SELECT reason, detail FROM candidate_review_flags WHERE cid = 'TEST-NEW-UNRESOLVABLE-MOBILE'
    `;
    check(
      results,
      "New row: unresolvable mobile also writes an 'unclean_contact_number' review flag with the raw value",
      uncleanMobileFlags.length === 1 &&
        uncleanMobileFlags[0].reason === "unclean_contact_number" &&
        uncleanMobileFlags[0].detail.raw === "9000000004/9000000005",
      JSON.stringify(uncleanMobileFlags)
    );

    // Blank/placeholder mobile ("-") must NOT be flagged — it's intentionally blank, not unclean.
    const blankMobileFlags = await sql`
      SELECT * FROM candidate_review_flags WHERE cid IN ('TEST-EXISTING-1', 'TEST-EXISTING-2', 'TEST-UNTOUCHED') AND reason = 'unclean_contact_number'
    `;
    check(
      results,
      "Rows with a clean/blank mobile never get an 'unclean_contact_number' flag",
      blankMobileFlags.length === 0
    );

    const jrConflict = await byCid("TEST-NEW-JR-CONFLICT");
    check(
      results,
      "JR conflict: primary_skills (agrees in both tables) used normally, not blanked",
      jrConflict?.primary_skills === "Skill Shared"
    );
    check(
      results,
      "JR conflict: job_management_level (conflicts) left '-' on insert, not silently preferring either table",
      jrConflict?.job_management_level === "-"
    );
    check(results, "JR conflict: market (conflicts) left '-' on insert", jrConflict?.market === "-");
    check(
      results,
      "JR conflict: client_spoc (lateral-only, executive has no column) used normally, not blanked",
      jrConflict?.client_spoc === "Lateral SPOC"
    );
    const conflictFlags = await sql`SELECT reason, detail FROM candidate_review_flags WHERE cid = 'TEST-NEW-JR-CONFLICT'`;
    check(
      results,
      "JR conflict: 2 review flags written (job_management_level + market), both both tables' values recorded",
      conflictFlags.length === 2 && conflictFlags.every((f: { reason: string }) => f.reason === "jr_id_conflict"),
      JSON.stringify(conflictFlags)
    );

    // -- Prove the "accumulates every run, dashboard shows only latest" design for C9 --
    const [historyRow2] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, result, source_filename)
      VALUES (NOW(), 'success', 'verify-candidate-sync-engine-test-rerun')
      RETURNING id
    `;
    const syncId2 = historyRow2.id;
    await runCandidateSync(
      [
        row({
          sheetRowNumber: 1,
          cid: "TEST-NEW-JR-CONFLICT",
          firstName: "New",
          lastName: "Conflict",
          mobile: "9000000008",
          email: "conflict@example.com",
          clientSubmissionJr: "TEST-JR-CONFLICT",
          customerJobTitle: "should-not-be-used",
          market: "should-not-be-used",
          clientSpoc: "should-not-be-used",
        }),
      ],
      syncId2,
      sql
    );
    const conflictFlagsAfterRerun = await sql`
      SELECT sync_id, reason FROM candidate_review_flags WHERE cid = 'TEST-NEW-JR-CONFLICT' ORDER BY sync_id, reason
    `;
    check(
      results,
      "Recurring conflict: a SECOND sync run writes 2 MORE flag rows (4 total) — append-only, full history preserved",
      conflictFlagsAfterRerun.length === 4,
      JSON.stringify(conflictFlagsAfterRerun)
    );
    // NOT a naive `DISTINCT ON (cid, reason)` — that would wrongly collapse
    // the two simultaneously-conflicting fields (job_management_level AND
    // market) down to one. Correct pattern: MAX(sync_id) per (cid, reason),
    // then every row matching that exact (cid, reason, sync_id).
    const mostRecentPerIssue = await sql`
      SELECT crf.cid, crf.reason, crf.sync_id, crf.detail
      FROM candidate_review_flags crf
      JOIN (
        SELECT cid, reason, MAX(sync_id) AS latest_sync_id
        FROM candidate_review_flags
        WHERE cid = 'TEST-NEW-JR-CONFLICT'
        GROUP BY cid, reason
      ) latest
        ON crf.cid = latest.cid AND crf.reason = latest.reason AND crf.sync_id = latest.latest_sync_id
      WHERE crf.cid = 'TEST-NEW-JR-CONFLICT'
    `;
    check(
      results,
      "The C9 'most recent per issue' query (MAX(sync_id) per cid,reason, join back) correctly returns BOTH simultaneous field conflicts from the LATEST sync, not just one",
      mostRecentPerIssue.length === 2 && mostRecentPerIssue.every((r: { sync_id: number }) => r.sync_id === syncId2),
      JSON.stringify(mostRecentPerIssue)
    );
    const naiveDistinctOn = await sql`
      SELECT DISTINCT ON (cid, reason) cid, reason, sync_id
      FROM candidate_review_flags
      WHERE cid = 'TEST-NEW-JR-CONFLICT'
      ORDER BY cid, reason, created_at DESC
    `;
    check(
      results,
      "Confirms the naive DISTINCT ON (cid,reason) approach really is wrong: it drops one of the two simultaneous conflicts",
      naiveDistinctOn.length === 1,
      `naive query returned ${naiveDistinctOn.length} row(s) — proves why the MAX(sync_id)-join pattern above is required instead`
    );
    await sql`DELETE FROM candidate_review_flags WHERE sync_id = ${syncId2}`;
    await sql`DELETE FROM candidate_sync_history WHERE id = ${syncId2}`;

    const lateralOnly = await byCid("TEST-NEW-JR-LATERAL-ONLY");
    check(
      results,
      "JR found in lateral_master only: uses lateral's real values, ignores the poisoned Oorwin fallback",
      lateralOnly?.primary_skills === "Lateral Only Skill" &&
        lateralOnly?.job_management_level === "9-Team Lead" &&
        lateralOnly?.market === "Americas" &&
        lateralOnly?.client_spoc === "Lateral Only SPOC"
    );

    const notFound = await byCid("TEST-NEW-JR-NOT-FOUND");
    check(
      results,
      "JR not found anywhere: falls back to Oorwin's own values for primary_skills/market/client_spoc",
      notFound?.primary_skills === "Fallback Skill From Oorwin" &&
        notFound?.market === "Fallback Market From Oorwin" &&
        notFound?.client_spoc === "Fallback SPOC From Oorwin"
    );
    check(
      results,
      "JR not found anywhere: job_management_level stays '-' (no Oorwin fallback source exists for it)",
      notFound?.job_management_level === "-"
    );

    const commentsPrimary = await byCid("TEST-NEW-COMMENTS-PRIMARY");
    check(results, "Comments: primary column used when present", commentsPrimary?.submission_comments === "Primary Comment");

    const commentsFallback = await byCid("TEST-NEW-COMMENTS-FALLBACK");
    check(
      results,
      "Comments: falls back to Reason for Rejection when Submission Comments is blank",
      commentsFallback?.submission_comments === "Fallback Comment"
    );

    const commentsBothBlank = await byCid("TEST-NEW-COMMENTS-BOTH-BLANK");
    check(results, "Comments: both blank → '-'", commentsBothBlank?.submission_comments === "-");

    const dupSame = await byCid("TEST-DUP-SAME");
    check(
      results,
      "Duplicate CID, same name in-sheet: collapses to ONE row (last row in sheet order wins)",
      dupSame !== undefined
    );
    check(results, "Duplicate CID, same name: last row's Status wins ('Second Status')", dupSame?.status === "Second Status");
    const dupSameCount = Number(
      (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_master WHERE cid = 'TEST-DUP-SAME'`)[0]?.c ?? "0"
    );
    check(results, "Duplicate CID, same name: exactly one row exists (not two)", dupSameCount === 1);

    check(
      results,
      "combineCandidateName sanity: TEST-DUP-SAME's name combined correctly",
      dupSame?.name === combineCandidateName("Dup", "-", "Same")
    );

    // -- cleanup: remove everything this test wrote, leave the DB as found --
    const testCids = sheet.map((r) => r.cid).filter((c) => c !== "-").concat(["TEST-UNTOUCHED"]);
    await sql`DELETE FROM candidate_review_flags WHERE cid = ANY(${testCids})`;
    await sql`DELETE FROM candidate_sync_changes WHERE cid = ANY(${testCids})`;
    await sql`DELETE FROM candidate_master WHERE cid = ANY(${testCids})`;
    await sql`DELETE FROM candidate_sync_history WHERE id = ${syncId}`;
    await sql`DELETE FROM lateral_master WHERE job_requisition_id IN ('TEST-JR-CONFLICT', 'TEST-JR-LATERAL-ONLY')`;
    await sql`DELETE FROM executive_master WHERE job_requisition_id = 'TEST-JR-CONFLICT'`;
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
