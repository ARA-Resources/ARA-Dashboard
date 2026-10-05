/**
 * Integration validation for the Accenture Final Report upload engine
 * (candidate-accenture-engine.ts) and job (candidate-accenture-sync-job.ts)
 * against a real throwaway/test Postgres.
 *
 * Covers: matched-row updates applying to ALL live rows sharing a CID (no
 * JR narrowing, unlike Oorwin); the insert path; blank/unparseable email
 * and level never overwriting or locking; the 3 snapshot fields' plain
 * diff (blank -> "-"); name-mismatch note + its re-upload dedupe; the
 * Accenture lock surviving a synthetic Oorwin upload with zero review flag
 * / zero change row and the new accentureLockedFieldsKeptCount banner
 * counter; a manual Modify of a locked field still saving while the lock
 * itself stays TRUE; and a forced mid-file failure rolling back the WHOLE
 * transaction (not just the failing row), leaving exactly one 'failed'
 * history row.
 *
 * DESTRUCTIVE — writes to candidate_master / candidate_sync_history /
 * candidate_sync_changes / candidate_review_flags. Throwaway/test DB only.
 * Every row this script creates uses a CID unique to this run and is
 * deleted in a `finally` block, success or failure.
 *
 * Run: npx tsx scripts/verify-candidate-accenture-engine.ts
 */
import * as XLSX from "xlsx";
import { closeDbClient, getDbClient } from "../src/lib/persistence/db-client";
import {
  getCandidateMasterById,
  getCandidateMasterRowsByCid,
  type CandidateMasterRow,
  type SqlClient,
} from "../src/services/persistence/read-candidate-master";
import { runCandidateAccentureSync } from "../src/services/candidate-processing/candidate-accenture-engine";
import { invokeCandidateAccentureSync } from "../src/services/candidate-processing/candidate-accenture-sync-job";
import type { CandidateAccentureParsedRow } from "../src/services/candidate-processing/candidate-accenture-parser";
import { runCandidateSync } from "../src/services/candidate-processing/candidate-sync-engine";
import type { CandidateOorwinParsedRow } from "../src/services/candidate-processing/candidate-oorwin-parser";
import { updateCandidateManualRow } from "../src/services/candidate-processing/candidate-manual-edit";
import type { CandidateManualFieldValues } from "../src/services/candidate-processing/candidate-manual-edit";

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
const CID = (n: number) => `C9${RUN_ID}${n}`;
const cidsUsed: string[] = [];
const syncIdsUsed: number[] = [];

function fileRow(
  cid: string,
  overrides: Partial<CandidateAccentureParsedRow> = {}
): CandidateAccentureParsedRow {
  return {
    sheetRowNumber: 1,
    cid,
    name: "File Name",
    email: "-",
    level: "-",
    applicationCompletionStatus: "-",
    candidateStage: "-",
    currentCidSource: "-",
    ...overrides,
  };
}

async function seedRow(
  sql: SqlClient,
  cid: string,
  overrides: Partial<{
    name: string;
    email: string;
    job_management_level: string;
    accenture_candidate_stage: string;
    current_cid_source: string;
    application_completion_status: string;
    job_requisition_id: string;
    email_accenture_locked: boolean;
    job_management_level_accenture_locked: boolean;
    last_accenture_sync_id: number | null;
  }> = {}
): Promise<CandidateMasterRow> {
  cidsUsed.push(cid);
  const [{ id }] = await sql<{ id: number }[]>`
    INSERT INTO candidate_master (
      cid, name, gender, contact_number, date_of_upload, submitter, customer,
      job_requisition_id, primary_skills, job_management_level, market,
      client_spoc, status, accenture_candidate_stage, current_cid_source,
      application_completion_status, screening_candidate_stage, disposition_reason,
      submitted_date, submission_comments, email,
      email_accenture_locked, job_management_level_accenture_locked, last_accenture_sync_id
    ) VALUES (
      ${cid}, ${overrides.name ?? "Seed Name"}, '-', '-', '-', '-', '-',
      ${overrides.job_requisition_id ?? "-"}, '-', ${overrides.job_management_level ?? "-"}, '-',
      '-', '-', ${overrides.accenture_candidate_stage ?? "-"}, ${overrides.current_cid_source ?? "-"},
      ${overrides.application_completion_status ?? "-"}, '-', '-',
      '-', '-', ${overrides.email ?? "-"},
      ${overrides.email_accenture_locked ?? false}, ${overrides.job_management_level_accenture_locked ?? false},
      ${overrides.last_accenture_sync_id ?? null}
    ) RETURNING id
  `;
  const row = await getCandidateMasterById(Number(id), sql);
  if (!row) throw new Error("seedRow: row vanished immediately after insert");
  return row;
}

async function makeSyncId(sql: SqlClient): Promise<number> {
  const [{ id }] = await sql<{ id: number }[]>`
    INSERT INTO candidate_sync_history (started_at, result, kind)
    VALUES (NOW(), 'success', 'accenture_upload') RETURNING id
  `;
  const syncId = Number(id);
  syncIdsUsed.push(syncId);
  return syncId;
}

async function main() {
  const sql = getDbClient();

  const existingCount = Number(
    (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_master`)[0]?.c ?? "0"
  );
  if (existingCount > 100) {
    throw new Error(
      `candidate_master has ${existingCount} rows — refusing to run this destructive test against what looks like real data. Point POSTGRES_URL at a throwaway database.`
    );
  }

  try {
    // ===== 1. Insert path: new CID, full fields, locks per usable value =====
    {
      const cid = CID(1);
      const syncId = await makeSyncId(sql);
      const rows = [
        fileRow(cid, {
          name: "First Occ",
          email: "first@x.com",
          level: "9-Team Lead/Consultant",
          candidateStage: "Review",
          currentCidSource: "Job Boards",
          applicationCompletionStatus: "Yes",
        }),
        fileRow(cid, {
          name: "Final Occ",
          email: "final@x.com",
          level: "CL10",
          candidateStage: "On Hold",
          currentCidSource: "Recruiting Agency",
          applicationCompletionStatus: "",
        }),
      ];
      const summary = await runCandidateAccentureSync(rows, syncId, sql, { dryRun: false });
      check("Insert: insertedCount is 1", summary.insertedCount === 1, String(summary.insertedCount));
      cidsUsed.push(cid);
      const [row] = await getCandidateMasterRowsByCid(cid, sql);
      check("Insert: Name/Email are the LAST occurrence's values", row?.name === "Final Occ" && row?.email === "final@x.com", JSON.stringify({ name: row?.name, email: row?.email }));
      check("Insert: level stored as CLn (canonical), last occurrence's number", row?.job_management_level === "CL10", row?.job_management_level);
      check("Insert: 3 snapshot fields from the last occurrence, blank -> '-'", row?.accenture_candidate_stage === "On Hold" && row?.current_cid_source === "Recruiting Agency" && row?.application_completion_status === "-", JSON.stringify(row));
      check("Insert: no Job Requisition ID ('-')", row?.job_requisition_id === "-", row?.job_requisition_id);
      check("Insert: locks set TRUE (usable email+level supplied)", row?.email_accenture_locked === true && row?.job_management_level_accenture_locked === true);
      check("Insert: inserted_sync_id and last_accenture_sync_id both = this run", row?.inserted_sync_id === syncId && row?.last_accenture_sync_id === syncId);
      check("Insert: last_touched_at is set (not null)", row?.last_touched_at != null);
    }

    // ===== 2. Matched update: step-chain history, idempotent re-upload =====
    {
      const cid = CID(2);
      const seeded = await seedRow(sql, cid, { email: "stored@x.com" });
      const syncId1 = await makeSyncId(sql);
      const rows1 = [
        fileRow(cid, { email: "a@x.com" }),
        fileRow(cid, { email: "b@x.com" }),
        fileRow(cid, { email: "c@x.com" }),
      ];
      const summary1 = await runCandidateAccentureSync(rows1, syncId1, sql, { dryRun: false });
      check("Matched update: matchedCidCount=1, matchedRowCount=1", summary1.matchedCidCount === 1 && summary1.matchedRowCount === 1);
      check("Matched update: email fieldChangeCounts = 1", summary1.fieldChangeCounts.email === 1, String(summary1.fieldChangeCounts.email));
      const after1 = await getCandidateMasterById(seeded.id, sql);
      check("Matched update: email is now the final occurrence (c@x.com)", after1?.email === "c@x.com", after1?.email);
      check("Matched update: email_accenture_locked flipped TRUE", after1?.email_accenture_locked === true);
      const changeRows1 = await sql<{ old_value: string; new_value: string }[]>`
        SELECT old_value, new_value FROM candidate_sync_changes
        WHERE candidate_master_id = ${seeded.id} AND field_name = 'email' ORDER BY id ASC
      `;
      check(
        "Matched update: exactly 3 step rows logged (stored->a, a->b, b->c)",
        changeRows1.length === 3 &&
          changeRows1[0].old_value === "stored@x.com" && changeRows1[0].new_value === "a@x.com" &&
          changeRows1[1].old_value === "a@x.com" && changeRows1[1].new_value === "b@x.com" &&
          changeRows1[2].old_value === "b@x.com" && changeRows1[2].new_value === "c@x.com",
        JSON.stringify(changeRows1)
      );
      const touchedAfter1 = after1?.last_touched_at;

      // Re-upload the SAME file against the now-updated row -> idempotent: 0 new change rows, email field change count 0, but last_accenture_sync_id still advances and last_touched_at does NOT move.
      await new Promise((r) => setTimeout(r, 10));
      const syncId2 = await makeSyncId(sql);
      const summary2 = await runCandidateAccentureSync(rows1, syncId2, sql, { dryRun: false });
      check("Re-upload: email fieldChangeCounts = 0 (idempotent)", summary2.fieldChangeCounts.email === 0, String(summary2.fieldChangeCounts.email));
      const after2 = await getCandidateMasterById(seeded.id, sql);
      check("Re-upload: email unchanged (still c@x.com)", after2?.email === "c@x.com");
      check("Re-upload: last_accenture_sync_id advanced to the NEW run", after2?.last_accenture_sync_id === syncId2, String(after2?.last_accenture_sync_id));
      check("Re-upload: last_touched_at did NOT move (no visible field changed)", after2?.last_touched_at === touchedAfter1, JSON.stringify({ before: touchedAfter1, after: after2?.last_touched_at }));
      const changeRows2 = await sql<{ id: number }[]>`
        SELECT id FROM candidate_sync_changes WHERE candidate_master_id = ${seeded.id} AND field_name = 'email'
      `;
      check("Re-upload: still exactly 3 email change rows total (0 new)", changeRows2.length === 3, String(changeRows2.length));
    }

    // ===== 3. Multiple live rows sharing one CID: apply to ALL, no narrowing =====
    {
      const cid = CID(3);
      const rowA = await seedRow(sql, cid, { email: "rowA@x.com", job_requisition_id: "JR-A" });
      const rowB = await seedRow(sql, cid, { email: "rowB@x.com", job_requisition_id: "JR-B" });
      const syncId = await makeSyncId(sql);
      const rows = [fileRow(cid, { email: "shared@x.com" })];
      const summary = await runCandidateAccentureSync(rows, syncId, sql, { dryRun: false });
      check("Multi-row CID: matchedCidCount=1, matchedRowCount=2 (both rows, no JR narrowing)", summary.matchedCidCount === 1 && summary.matchedRowCount === 2, JSON.stringify(summary));
      const afterA = await getCandidateMasterById(rowA.id, sql);
      const afterB = await getCandidateMasterById(rowB.id, sql);
      check("Multi-row CID: BOTH rows got the same final email, independently of JR id", afterA?.email === "shared@x.com" && afterB?.email === "shared@x.com", JSON.stringify({ a: afterA?.email, b: afterB?.email }));
    }

    // ===== 4. Blank/unparseable email+level never overwrite, never lock; snapshot fields plain-diff blank -> "-" =====
    {
      const cid = CID(4);
      const seeded = await seedRow(sql, cid, {
        email: "keep@x.com",
        job_management_level: "CL5",
        accenture_candidate_stage: "Review",
      });
      const syncId = await makeSyncId(sql);
      const rows = [
        fileRow(cid, { email: "", level: "N/A", candidateStage: "" }),
      ];
      const summary = await runCandidateAccentureSync(rows, syncId, sql, { dryRun: false });
      const after = await getCandidateMasterById(seeded.id, sql);
      check("Blank email: stored value UNCHANGED", after?.email === "keep@x.com", after?.email);
      check("Blank email: lock stays FALSE (never set from a blank cell)", after?.email_accenture_locked === false);
      check("Unparseable level ('N/A'): stored value UNCHANGED", after?.job_management_level === "CL5", after?.job_management_level);
      check("Unparseable level: lock stays FALSE", after?.job_management_level_accenture_locked === false);
      check("Blank snapshot field (Candidate Stage): plain diff still applies, blank cell stored as '-'", after?.accenture_candidate_stage === "-", after?.accenture_candidate_stage);
      check("Blank snapshot field counted in blankCellsKeptCount", summary.blankCellsKeptCount >= 1, String(summary.blankCellsKeptCount));
      check("Email/level fieldChangeCounts are 0 (nothing usable supplied)", summary.fieldChangeCounts.email === 0 && summary.fieldChangeCounts.job_management_level === 0);
    }

    // ===== 5. Name mismatch: logged once, deduped on exact re-upload, new note on a genuinely new name =====
    {
      const cid = CID(5);
      const seeded = await seedRow(sql, cid, { name: "Original Name" });
      const syncIdA = await makeSyncId(sql);
      const rowsA = [fileRow(cid, { name: "Different Name" })];
      await runCandidateAccentureSync(rowsA, syncIdA, sql, { dryRun: false });
      const afterA = await getCandidateMasterById(seeded.id, sql);
      check("Name mismatch: stored name column is NEVER written", afterA?.name === "Original Name", afterA?.name);
      const notesA = await sql<{ old_value: string; new_value: string }[]>`
        SELECT old_value, new_value FROM candidate_sync_changes WHERE candidate_master_id = ${seeded.id} AND field_name = 'name' ORDER BY id ASC
      `;
      check("Name mismatch: exactly 1 note logged (old=Original Name, new=Different Name)", notesA.length === 1 && notesA[0].old_value === "Original Name" && notesA[0].new_value === "Different Name", JSON.stringify(notesA));

      // Re-upload the SAME file name -> deduped, 0 new notes.
      const syncIdB = await makeSyncId(sql);
      await runCandidateAccentureSync(rowsA, syncIdB, sql, { dryRun: false });
      const notesB = await sql<{ id: number }[]>`
        SELECT id FROM candidate_sync_changes WHERE candidate_master_id = ${seeded.id} AND field_name = 'name'
      `;
      check("Name mismatch re-upload: still exactly 1 note (deduped, 0 new)", notesB.length === 1, String(notesB.length));

      // A genuinely different name on a later upload -> a NEW note is written.
      const syncIdC = await makeSyncId(sql);
      const rowsC = [fileRow(cid, { name: "Yet Another Name" })];
      await runCandidateAccentureSync(rowsC, syncIdC, sql, { dryRun: false });
      const notesC = await sql<{ new_value: string }[]>`
        SELECT new_value FROM candidate_sync_changes WHERE candidate_master_id = ${seeded.id} AND field_name = 'name' ORDER BY id ASC
      `;
      check("Name mismatch, new file name: a SECOND note is written (2 total)", notesC.length === 2 && notesC[1].new_value === "Yet Another Name", JSON.stringify(notesC));
    }

    // ===== 6. Lock survives a synthetic Oorwin upload: no review flag, no change row, banner counter =====
    {
      const cid = CID(6);
      const locked = await seedRow(sql, cid, {
        email: "accenture-locked@x.com",
        job_management_level: "CL7",
        email_accenture_locked: true,
        job_management_level_accenture_locked: true,
      });
      const [{ id: oorwinSyncId }] = await sql<{ id: number }[]>`
        INSERT INTO candidate_sync_history (started_at, result, kind, source_filename, triggered_by)
        VALUES (NOW(), 'success', 'oorwin_upload', 'synthetic-oorwin.xls', 'verify-script@example.com') RETURNING id
      `;
      syncIdsUsed.push(Number(oorwinSyncId));
      const oorwinRow: CandidateOorwinParsedRow = {
        sheetRowNumber: 1,
        cid,
        firstName: "Oorwin",
        middleName: "-",
        lastName: "Row",
        email: "oorwin-different@x.com",
        mobile: "-",
        gender: "-",
        submitter: "-",
        customer: "-",
        clientSubmissionJr: "JR-DIFFERENT",
        customerJobTitle: "-",
        market: "-",
        clientSpoc: "-",
        status: "-",
        submittedDate: "-",
        reasonForRejection: "-",
        submissionComments: "-",
      };
      const oorwinSummary = await runCandidateSync([oorwinRow], Number(oorwinSyncId), sql);
      const afterOorwin = await getCandidateMasterById(locked.id, sql);
      check("Lock survives Oorwin: email UNCHANGED despite a different Oorwin value", afterOorwin?.email === "accenture-locked@x.com", afterOorwin?.email);
      check("Lock survives Oorwin: job_management_level UNCHANGED", afterOorwin?.job_management_level === "CL7", afterOorwin?.job_management_level);
      check("Lock survives Oorwin: accentureLockedFieldsKeptCount reflects both skipped fields", oorwinSummary.accentureLockedFieldsKeptCount === 2, String(oorwinSummary.accentureLockedFieldsKeptCount));
      const lockChangeRows = await sql<{ id: number }[]>`
        SELECT id FROM candidate_sync_changes WHERE candidate_master_id = ${locked.id} AND field_name IN ('email', 'job_management_level') AND sync_id = ${Number(oorwinSyncId)}
      `;
      check("Lock survives Oorwin: NO candidate_sync_changes row written for the skipped fields", lockChangeRows.length === 0, String(lockChangeRows.length));
      const lockFlags = await sql<{ id: number }[]>`
        SELECT id FROM candidate_review_flags WHERE cid = ${cid} AND sync_id = ${Number(oorwinSyncId)} AND reason != 'jr_id_conflict'
      `;
      check("Lock survives Oorwin: NO new review flag written for the lock itself", lockFlags.length === 0, String(lockFlags.length));
    }

    // ===== 7. Manual Modify of a locked field still saves; the lock itself stays TRUE =====
    {
      const cid = CID(7);
      const locked = await seedRow(sql, cid, {
        email: "locked-before-modify@x.com",
        email_accenture_locked: true,
        job_management_level_accenture_locked: true,
        last_accenture_sync_id: await makeSyncId(sql),
      });
      const fullOriginal: CandidateManualFieldValues = {
        cid: locked.cid,
        date_of_upload: "-",
        name: locked.name,
        email: locked.email,
        contact_number: "-",
        submitter: "-",
        customer: "-",
        job_requisition_id: "-",
        primary_skills: "-",
        job_management_level: "-",
        market: "-",
        client_spoc: "-",
        status: "-",
        accenture_candidate_stage: "-",
        current_cid_source: "-",
        application_completion_status: "-",
        screening_candidate_stage: "-",
        disposition_reason: "-",
        submitted_date: "-",
        submission_comments: "-",
        gender: "-",
      };
      const newValues: CandidateManualFieldValues = { ...fullOriginal, email: "manually-typed@x.com" };
      const outcome = await updateCandidateManualRow(locked.id, newValues, null, fullOriginal, "verify-script@example.com", sql);
      check("Manual Modify on a locked row: status 'ok'", outcome.status === "ok", outcome.status);
      if (outcome.status === "ok") {
        check("Manual Modify: the field itself DID save the new value", outcome.result.row.email === "manually-typed@x.com", outcome.result.row.email);
        check("Manual Modify: email_accenture_locked stays TRUE (manual edit never touches the lock)", outcome.result.row.email_accenture_locked === true);
        check("Manual Modify: last_accenture_sync_id is untouched by the manual edit", outcome.result.row.last_accenture_sync_id === locked.last_accenture_sync_id);
      }
    }

    // ===== 8. Transaction rollback: forced mid-file failure rolls back EVERYTHING =====
    {
      const cidOk = CID(81);
      const cidFail = CID(82);
      const seededOk = await seedRow(sql, cidOk, { email: "before-rollback@x.com" });

      // Force a PK violation on the SECOND (insert) CID: rewind
      // candidate_master_id_seq so the next INSERT's auto-generated id
      // collides with an id that already exists (any live row's id — we
      // use seededOk's own id, captured before the rewind).
      const anchorId = seededOk.id;
      await sql`SELECT setval('candidate_master_id_seq', ${anchorId - 1}, true)`;

      // invokeCandidateAccentureSync parses a real file buffer; to drive it
      // with these exact synthetic rows this test reuses the job's own
      // try/catch-around-sql.begin shape directly, calling the SAME
      // runCandidateAccentureSync the real job calls — still "through the
      // engine", just without needing a real .xlsx buffer.
      let threw = false;
      let failureMessage = "";
      const startedAt = new Date();
      try {
        await sql.begin(async (tx) => {
          const [historyRow] = await tx<{ id: number }[]>`
            INSERT INTO candidate_sync_history (started_at, result, source_filename, triggered_by, rows_in_sheet, kind)
            VALUES (${startedAt}, 'success', 'rollback-test.xlsx', 'verify-script@example.com', 2, 'accenture_upload')
            RETURNING id
          `;
          const txSyncId = Number(historyRow.id);
          const rows = [
            fileRow(cidOk, { email: "would-have-changed@x.com" }),
            fileRow(cidFail, { name: "New Row", email: "new@x.com" }),
          ];
          await runCandidateAccentureSync(rows, txSyncId, tx, { dryRun: false });
        });
      } catch (err) {
        threw = true;
        failureMessage = err instanceof Error ? err.message : String(err);
        const [failedRow] = await sql<{ id: number }[]>`
          INSERT INTO candidate_sync_history (started_at, finished_at, result, source_filename, triggered_by, failure_reason, kind)
          VALUES (${startedAt}, NOW(), 'failed', 'rollback-test.xlsx', 'verify-script@example.com', ${failureMessage}, 'accenture_upload')
          RETURNING id
        `;
        syncIdsUsed.push(Number(failedRow.id));
      }

      check("Rollback: the forced PK violation actually threw", threw, failureMessage.slice(0, 120));
      const afterRollback = await getCandidateMasterById(seededOk.id, sql);
      check("Rollback: the FIRST CID's update was UNDONE (email back to its pre-run value)", afterRollback?.email === "before-rollback@x.com", afterRollback?.email);
      const failRowCount = Number(
        (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_master WHERE cid = ${cidFail}`)[0]?.c ?? "0"
      );
      check("Rollback: the SECOND CID's insert never persisted either (whole transaction undone)", failRowCount === 0, String(failRowCount));
      const failedHistoryRows = await sql<{ id: number; result: string }[]>`
        SELECT id, result FROM candidate_sync_history WHERE source_filename = 'rollback-test.xlsx'
      `;
      check("Rollback: exactly ONE history row exists for this run, and it is 'failed'", failedHistoryRows.length === 1 && failedHistoryRows[0].result === "failed", JSON.stringify(failedHistoryRows));

      // Restore the sequence so it doesn't collide with future inserts in this script/DB.
      const maxId = Number(
        (await sql<{ m: string }[]>`SELECT COALESCE(MAX(id), 0)::text AS m FROM candidate_master`)[0]?.m ?? "0"
      );
      await sql`SELECT setval('candidate_master_id_seq', ${maxId}, true)`;
    }

    // ===== 9. Dry run: zero writes, full counts =====
    {
      const cid = CID(9);
      const seeded = await seedRow(sql, cid, { email: "dry-run-untouched@x.com" });
      const rows = [fileRow(cid, { email: "would-be-new@x.com" })];
      const summary = await runCandidateAccentureSync(rows, null, sql, { dryRun: true });
      check("Dry run: reports the field WOULD change", summary.fieldChangeCounts.email === 1, String(summary.fieldChangeCounts.email));
      const after = await getCandidateMasterById(seeded.id, sql);
      check("Dry run: the row is actually UNTOUCHED (zero writes)", after?.email === "dry-run-untouched@x.com", after?.email);
      check("Dry run: last_accenture_sync_id untouched", after?.last_accenture_sync_id === null, String(after?.last_accenture_sync_id));
      const changeRows = await sql<{ id: number }[]>`
        SELECT id FROM candidate_sync_changes WHERE candidate_master_id = ${seeded.id}
      `;
      check("Dry run: zero candidate_sync_changes rows written", changeRows.length === 0, String(changeRows.length));
    }
    // ===== 10. Full job-level smoke test: real .xlsx buffer through invokeCandidateAccentureSync =====
    {
      const cid = CID(10);
      const seeded = await seedRow(sql, cid, { email: "job-level-before@x.com" });
      const headerRow = [
        "Agency Name",
        "Candidate Name",
        "Candidate Email",
        "Candidate ID",
        "Management Level",
        "Application Completion Status",
        "Candidate Stage",
        "Entity Name",
        "SubEntity Name",
        "First Source Category (Recruiting agency)",
        "Current CID Source (As per candidate latest application)",
        "Comments\n",
        "Day since referal was made",
      ];
      const dataRow = [
        "Test Agency",
        "Job Level Test",
        "job-level-after@x.com",
        cid,
        "CL9",
        "Yes",
        "Review",
        "Test Entity",
        "Test SubEntity",
        "Recruiting Agency",
        "Recruiting Agency",
        "",
        0,
      ];
      const ws = XLSX.utils.aoa_to_sheet([headerRow, dataRow]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

      const result = await invokeCandidateAccentureSync(buffer, "job-level-smoke.xlsx", "verify-script@example.com", sql, false);
      if (result.syncId != null) syncIdsUsed.push(result.syncId);
      check("Job-level: result is 'success'", result.result === "success", result.result);
      check("Job-level: matchedCidCount/matchedRowCount = 1/1", result.counts.matchedCidCount === 1 && result.counts.matchedRowCount === 1, JSON.stringify(result.counts));
      const historyRow = result.syncId
        ? (await sql<{ kind: string; result: string }[]>`SELECT kind, result FROM candidate_sync_history WHERE id = ${result.syncId}`)[0]
        : null;
      check("Job-level: history row stamped kind='accenture_upload'", historyRow?.kind === "accenture_upload", historyRow?.kind);
      const afterJob = await getCandidateMasterById(seeded.id, sql);
      check("Job-level: email actually updated end-to-end through the real route-equivalent path", afterJob?.email === "job-level-after@x.com", afterJob?.email);
    }
  } finally {
    // FK-safe cleanup order: review_flags/sync_changes (reference sync_history)
    // -> candidate_master (references sync_history via inserted/last_accenture
    // _sync_id) -> sync_history itself.
    await sql`DELETE FROM candidate_review_flags WHERE cid = ANY(${cidsUsed})`;
    if (syncIdsUsed.length > 0) {
      await sql`DELETE FROM candidate_review_flags WHERE sync_id = ANY(${syncIdsUsed})`;
    }
    await sql`DELETE FROM candidate_sync_changes WHERE cid = ANY(${cidsUsed})`;
    await sql`DELETE FROM candidate_master WHERE cid = ANY(${cidsUsed})`;
    if (syncIdsUsed.length > 0) {
      await sql`DELETE FROM candidate_sync_history WHERE id = ANY(${syncIdsUsed})`;
    }
    await sql`DELETE FROM candidate_sync_history WHERE source_filename = 'rollback-test.xlsx'`;
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
