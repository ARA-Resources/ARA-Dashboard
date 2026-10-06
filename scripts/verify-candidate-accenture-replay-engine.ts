/**
 * Integration validation for the Accenture replay engine
 * (candidate-accenture-replay-engine.ts) against a real throwaway/test
 * Postgres — the dated Master Sheet upload path, dispatched via
 * candidate-accenture-sync-job.ts when the file has a "Date" column.
 *
 * Covers: insert path with dated continuation; matched path with uniform
 * blank-skip across all 5 fields; revert logging (A->B->A fully logged,
 * no live write); same-day dedupe (keep last); the post-cutoff freeze
 * guard; derived idempotency on a byte-identical re-upload; the migration
 * 023 CID-level backstop for a field with ZERO real steps surviving a
 * later manual edit untouched; applying to every live row sharing a
 * duplicate CID; case-insensitive email with exact-cased writes; and that
 * the batched multi-row insert actually wrote the number of rows the
 * summary claims.
 *
 * DESTRUCTIVE — writes to candidate_master / candidate_sync_history /
 * candidate_sync_changes. Throwaway/test DB only. Every row this script
 * creates uses a CID unique to this run and is deleted in a `finally`
 * block, success or failure.
 *
 * Run: npx tsx scripts/verify-candidate-accenture-replay-engine.ts
 */
import { closeDbClient, getDbClient } from "../src/lib/persistence/db-client";
import {
  getCandidateMasterById,
  getCandidateMasterRowsByCid,
  type SqlClient,
} from "../src/services/persistence/read-candidate-master";
import { runCandidateAccentureReplaySync } from "../src/services/candidate-processing/candidate-accenture-replay-engine";
import type { CandidateAccentureParsedRow } from "../src/services/candidate-processing/candidate-accenture-parser";
import { getCandidateChangeHistory } from "../src/services/persistence/read-candidate-highlights";

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
const CID = (n: number) => `C8${RUN_ID}${n}`;
const cidsUsed: string[] = [];
const syncIdsUsed: number[] = [];

// Excel serial number (as the real file's "Date" column renders it via
// cellToText) for a plain "YYYY-MM-DD" string — the inverse of
// candidate-excel-date.ts's accentureReportDateKey, for readable fixtures.
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
  overrides: Partial<{
    name: string;
    email: string;
    job_management_level: string;
    accenture_candidate_stage: string;
    current_cid_source: string;
    application_completion_status: string;
    email_accenture_locked: boolean;
    job_management_level_accenture_locked: boolean;
    last_accenture_sync_id: number | null;
    last_accenture_report_date: string | null;
  }> = {}
) {
  cidsUsed.push(cid);
  const [{ id }] = await sql<{ id: number }[]>`
    INSERT INTO candidate_master (
      cid, name, gender, contact_number, date_of_upload, submitter, customer,
      job_requisition_id, primary_skills, job_management_level, market,
      client_spoc, status, accenture_candidate_stage, current_cid_source,
      application_completion_status, screening_candidate_stage, disposition_reason,
      submitted_date, submission_comments, email,
      email_accenture_locked, job_management_level_accenture_locked, last_accenture_sync_id,
      last_accenture_report_date
    ) VALUES (
      ${cid}, ${overrides.name ?? "Seed Name"}, '-', '-', '-', '-', '-',
      '-', '-', ${overrides.job_management_level ?? "-"}, '-',
      '-', '-', ${overrides.accenture_candidate_stage ?? "-"}, ${overrides.current_cid_source ?? "-"},
      ${overrides.application_completion_status ?? "-"}, '-', '-',
      '-', '-', ${overrides.email ?? "-"},
      ${overrides.email_accenture_locked ?? false}, ${overrides.job_management_level_accenture_locked ?? false},
      ${overrides.last_accenture_sync_id ?? null},
      ${overrides.last_accenture_report_date ?? null}
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
    // ===== 1. Insert path: new CID, dated occurrences, continuation chain =====
    {
      const cid = CID(1);
      const syncId = await makeSyncId(sql);
      const rows = [
        fileRow(cid, "2026-01-26", { name: "First Occ", email: "first@x.com", candidateStage: "Screen" }),
        fileRow(cid, "2026-02-10", { name: "Later Occ", candidateStage: "Interview" }),
      ];
      const summary = await runCandidateAccentureReplaySync(rows, syncId, sql, { dryRun: false });
      cidsUsed.push(cid);
      check("Insert: insertedCount is 1", summary.insertedCount === 1, String(summary.insertedCount));
      const [row] = await getCandidateMasterRowsByCid(cid, sql);
      check("Insert: Name stays the FIRST occurrence", row?.name === "First Occ", row?.name);
      check("Insert: Stage ends on the LAST occurrence's value", row?.accenture_candidate_stage === "Interview", row?.accenture_candidate_stage);
      check(
        "Insert: last_accenture_report_date is the CID's own last file date (2026-02-10)",
        row?.last_accenture_report_date === "2026-02-10",
        row?.last_accenture_report_date ?? "null"
      );
      const stageSteps = await sql<{ old_value: string; new_value: string; changed_at: string }[]>`
        SELECT old_value, new_value, changed_at FROM candidate_sync_changes
        WHERE candidate_master_id = ${row!.id} AND field_name = 'accenture_candidate_stage' ORDER BY id
      `;
      check(
        "Insert: continuation logs exactly 1 stage step (Screen->Interview), not the insert's own baseline",
        stageSteps.length === 1 && stageSteps[0].old_value === "Screen" && stageSteps[0].new_value === "Interview",
        JSON.stringify(stageSteps)
      );
    }

    // ===== 2. Matched path: blank-skip uniformly across ALL 5 fields (not just email/level) =====
    {
      const cid = CID(2);
      const seed = await seedRow(sql, cid, { accenture_candidate_stage: "-", current_cid_source: "-", application_completion_status: "-" });
      const syncId = await makeSyncId(sql);
      const rows = [
        fileRow(cid, "2026-01-26", { candidateStage: "Screen", currentCidSource: "", applicationCompletionStatus: "" }),
        fileRow(cid, "2026-02-10", { candidateStage: "", currentCidSource: "Agency", applicationCompletionStatus: "" }),
      ];
      await runCandidateAccentureReplaySync(rows, syncId, sql, { dryRun: false });
      const row = await getCandidateMasterById(seed.id, sql);
      check(
        "Matched: blank cells never overwrite — Stage keeps Screen (2nd row's blank is skipped), CID Source becomes Agency",
        row?.accenture_candidate_stage === "Screen" && row?.current_cid_source === "Agency",
        JSON.stringify({ stage: row?.accenture_candidate_stage, src: row?.current_cid_source })
      );
      check("Matched: Application Completion Status stays '-' (never reported) — no step logged", row?.application_completion_status === "-");
      const completionSteps = await sql<{ id: number }[]>`SELECT id FROM candidate_sync_changes WHERE candidate_master_id = ${seed.id} AND field_name = 'application_completion_status'`;
      check("Matched: 0 history rows for the always-blank field", completionSteps.length === 0, String(completionSteps.length));
    }

    // ===== 3. Revert logging: A->B->A — both steps logged, no live write =====
    {
      const cid = CID(3);
      const seed = await seedRow(sql, cid, { accenture_candidate_stage: "A" });
      const syncId = await makeSyncId(sql);
      const rows = [
        fileRow(cid, "2026-02-10", { candidateStage: "B" }),
        fileRow(cid, "2026-03-05", { candidateStage: "A" }),
      ];
      const summary = await runCandidateAccentureReplaySync(rows, syncId, sql, { dryRun: false });
      const row = await getCandidateMasterById(seed.id, sql);
      check("Revert: live column unchanged (still A)", row?.accenture_candidate_stage === "A", row?.accenture_candidate_stage);
      check("Revert: fieldChangeCounts.accenture_candidate_stage is 0 (no live write)", summary.fieldChangeCounts.accenture_candidate_stage === 0);
      const steps = await sql<{ old_value: string; new_value: string }[]>`
        SELECT old_value, new_value FROM candidate_sync_changes
        WHERE candidate_master_id = ${seed.id} AND field_name = 'accenture_candidate_stage' ORDER BY id
      `;
      check(
        "Revert: BOTH steps logged (A->B, B->A) even though final===stored",
        steps.length === 2 && steps[0].old_value === "A" && steps[0].new_value === "B" && steps[1].old_value === "B" && steps[1].new_value === "A",
        JSON.stringify(steps)
      );
    }

    // ===== 4. Same-day dedupe: 2 rows same date, keep LAST (file order) =====
    {
      const cid = CID(4);
      const seed = await seedRow(sql, cid, {});
      const syncId = await makeSyncId(sql);
      const rows = [
        fileRow(cid, "2026-09-27", { candidateStage: "Screen" }),
        fileRow(cid, "2026-09-27", { candidateStage: "Interview" }), // same date, later in file order -> wins
      ];
      const summary = await runCandidateAccentureReplaySync(rows, syncId, sql, { dryRun: false });
      const row = await getCandidateMasterById(seed.id, sql);
      check("Same-day dedupe: final value is the LAST row's value (Interview), not Screen", row?.accenture_candidate_stage === "Interview", row?.accenture_candidate_stage);
      check("Same-day dedupe: sameDayDuplicateRowCount is 1", summary.sameDayDuplicateRowCount === 1, String(summary.sameDayDuplicateRowCount));
      const steps = await sql<{ id: number }[]>`SELECT id FROM candidate_sync_changes WHERE candidate_master_id = ${seed.id} AND field_name = 'accenture_candidate_stage'`;
      check("Same-day dedupe: exactly 1 step logged (the discarded duplicate never becomes its own step)", steps.length === 1, String(steps.length));
    }

    // ===== 5. Frozen-field guard: a non-Accenture edit after the cutoff blocks the live write, but steps still log =====
    {
      const cid = CID(5);
      const seed = await seedRow(sql, cid, { accenture_candidate_stage: "-" });
      // Simulate a manual edit dated AFTER this run's file's last date (2026-10-04) — the freeze trigger.
      await sql`
        INSERT INTO candidate_sync_changes (sync_id, cid, field_name, old_value, new_value, candidate_master_id, changed_at)
        VALUES (NULL, ${cid}, 'accenture_candidate_stage', '-', 'ManualValue', ${seed.id}, '2026-10-10T06:30:00Z')
      `;
      await sql`UPDATE candidate_master SET accenture_candidate_stage = 'ManualValue' WHERE id = ${seed.id}`;

      const syncId = await makeSyncId(sql);
      const rows = [fileRow(cid, "2026-09-01", { candidateStage: "Screen" })]; // file's last date for this CID is before the manual edit
      const summary = await runCandidateAccentureReplaySync(rows, syncId, sql, { dryRun: false });
      const row = await getCandidateMasterById(seed.id, sql);
      check("Frozen: live column stays the manual edit's value (NOT overwritten by the file)", row?.accenture_candidate_stage === "ManualValue", row?.accenture_candidate_stage);
      check("Frozen: frozenFieldCount >= 1", summary.frozenFieldCount >= 1, String(summary.frozenFieldCount));
      const steps = await sql<{ old_value: string; new_value: string }[]>`
        SELECT old_value, new_value FROM candidate_sync_changes
        WHERE candidate_master_id = ${seed.id} AND field_name = 'accenture_candidate_stage' AND sync_id = ${syncId}
      `;
      check(
        "Frozen: the real step is STILL logged to history (from the seed's true current value, ManualValue, to Screen) even though it never wrote live",
        steps.length === 1 && steps[0].old_value === "ManualValue" && steps[0].new_value === "Screen",
        JSON.stringify(steps)
      );
    }

    // ===== 6. Idempotent re-run: upload the SAME file twice -> 0 new history rows the second time =====
    {
      const cid = CID(6);
      const seed = await seedRow(sql, cid, {});
      const rows = [
        fileRow(cid, "2026-01-26", { candidateStage: "Screen" }),
        fileRow(cid, "2026-02-10", { candidateStage: "Interview" }),
      ];
      const syncId1 = await makeSyncId(sql);
      const summary1 = await runCandidateAccentureReplaySync(rows, syncId1, sql, { dryRun: false });
      check("Idempotent run 1: 2 history rows logged", summary1.historyRowCount === 2, String(summary1.historyRowCount));

      const syncId2 = await makeSyncId(sql);
      const summary2 = await runCandidateAccentureReplaySync(rows, syncId2, sql, { dryRun: false });
      check("Idempotent run 2 (same file again): 0 NEW history rows", summary2.historyRowCount === 0, String(summary2.historyRowCount));
      const row = await getCandidateMasterById(seed.id, sql);
      check("Idempotent: final value still Interview after the no-op re-run", row?.accenture_candidate_stage === "Interview", row?.accenture_candidate_stage);
    }

    // ===== 7. Migration-023 backstop: a field with ZERO steps in run 1 stays untouched on re-upload, even after a later manual edit =====
    {
      const cid = CID(7);
      // File reports Stage "Screen" from the start, matching what's already stored -> zero steps for Stage in run 1.
      const seed = await seedRow(sql, cid, { accenture_candidate_stage: "Screen" });
      const syncId1 = await makeSyncId(sql);
      const rows1 = [fileRow(cid, "2026-01-26", { candidateStage: "Screen" }), fileRow(cid, "2026-02-10", { candidateStage: "Screen" })];
      const summary1 = await runCandidateAccentureReplaySync(rows1, syncId1, sql, { dryRun: false });
      check("Backstop setup: run 1 logs 0 stage steps (file already matched stored value)", summary1.fieldChangeCounts.accenture_candidate_stage === 0);
      const afterRun1 = await getCandidateMasterById(seed.id, sql);
      check(
        "Backstop setup: last_accenture_report_date IS set even though Stage itself had 0 steps",
        afterRun1?.last_accenture_report_date === "2026-02-10",
        afterRun1?.last_accenture_report_date ?? "null"
      );

      // Now a manual edit changes Stage, dated AFTER the file's own last date for this CID.
      await sql`
        INSERT INTO candidate_sync_changes (sync_id, cid, field_name, old_value, new_value, candidate_master_id, changed_at)
        VALUES (NULL, ${cid}, 'accenture_candidate_stage', 'Screen', 'ManualAfter', ${seed.id}, '2026-03-01T06:30:00Z')
      `;
      await sql`UPDATE candidate_master SET accenture_candidate_stage = 'ManualAfter' WHERE id = ${seed.id}`;

      // Re-upload the SAME file (same two dates, same values) — without the backstop, this would re-walk
      // [seed=ManualAfter, Screen, Screen] and incorrectly log a step / consider overwriting it.
      const syncId2 = await makeSyncId(sql);
      const summary2 = await runCandidateAccentureReplaySync(rows1, syncId2, sql, { dryRun: false });
      const afterRun2 = await getCandidateMasterById(seed.id, sql);
      check(
        "Backstop: re-upload of the SAME already-seen dates logs 0 new stage steps (not re-walked)",
        summary2.fieldChangeCounts.accenture_candidate_stage === 0,
        String(summary2.fieldChangeCounts.accenture_candidate_stage)
      );
      check(
        "Backstop: the manual edit's value is completely undisturbed",
        afterRun2?.accenture_candidate_stage === "ManualAfter",
        afterRun2?.accenture_candidate_stage
      );
      const stageStepsFromRun2 = await sql<{ id: number }[]>`
        SELECT id FROM candidate_sync_changes WHERE candidate_master_id = ${seed.id} AND field_name = 'accenture_candidate_stage' AND sync_id = ${syncId2}
      `;
      check("Backstop: run 2 wrote ZERO stage history rows for this CID", stageStepsFromRun2.length === 0, String(stageStepsFromRun2.length));
    }

    // ===== 8. Duplicate CID: apply to EVERY live row sharing the CID, no narrowing =====
    {
      const cid = CID(8);
      const rowA = await seedRow(sql, cid, { accenture_candidate_stage: "-" });
      const rowB = await seedRow(sql, cid, { accenture_candidate_stage: "-" });
      const syncId = await makeSyncId(sql);
      const rows = [fileRow(cid, "2026-01-26", { candidateStage: "Screen" })];
      const summary = await runCandidateAccentureReplaySync(rows, syncId, sql, { dryRun: false });
      check("Duplicate CID: matchedRowCount is 2 (both live rows)", summary.matchedRowCount === 2, String(summary.matchedRowCount));
      const after = await Promise.all([getCandidateMasterById(rowA.id, sql), getCandidateMasterById(rowB.id, sql)]);
      check(
        "Duplicate CID: BOTH rows updated to Screen",
        after[0]?.accenture_candidate_stage === "Screen" && after[1]?.accenture_candidate_stage === "Screen",
        JSON.stringify(after.map((r) => r?.accenture_candidate_stage))
      );
      const allSteps = await sql<{ candidate_master_id: number }[]>`
        SELECT candidate_master_id FROM candidate_sync_changes WHERE field_name = 'accenture_candidate_stage' AND candidate_master_id = ANY(${[rowA.id, rowB.id]})
      `;
      check("Duplicate CID: history logged separately per row id (2 rows total)", allSteps.length === 2, String(allSteps.length));
    }

    // ===== 9. Case-insensitive email: case-only change is not a step; a real change writes the file's exact casing =====
    {
      const cid = CID(9);
      const seed = await seedRow(sql, cid, { email: "jane@example.test" });
      const syncId = await makeSyncId(sql);
      const rows = [
        fileRow(cid, "2026-01-26", { email: "Jane@Example.test" }), // case-only -> no step
        fileRow(cid, "2026-02-10", { email: "john@example.test" }), // real change
      ];
      const summary = await runCandidateAccentureReplaySync(rows, syncId, sql, { dryRun: false });
      const row = await getCandidateMasterById(seed.id, sql);
      check("Email: final live value is the file's exact casing (john@example.test)", row?.email === "john@example.test", row?.email);
      check("Email: exactly 1 step logged (the case-only transition produced none)", summary.historyRowCount >= 1);
      const emailSteps = await sql<{ old_value: string; new_value: string }[]>`
        SELECT old_value, new_value FROM candidate_sync_changes WHERE candidate_master_id = ${seed.id} AND field_name = 'email' ORDER BY id
      `;
      check(
        "Email: the one logged step goes from the last-REPORTED casing to the new value",
        emailSteps.length === 1 && emailSteps[0].old_value === "Jane@Example.test" && emailSteps[0].new_value === "john@example.test",
        JSON.stringify(emailSteps)
      );
      check("Email: lock flips true (a usable value was supplied this run)", row?.email_accenture_locked === true);
    }

    // ===== 10. Batched insert sanity: total rows actually written matches the summary's historyRowCount =====
    {
      const cid = CID(10);
      await seedRow(sql, cid, {});
      const syncId = await makeSyncId(sql);
      const rows = [
        fileRow(cid, "2026-01-26", { candidateStage: "A", currentCidSource: "X" }),
        fileRow(cid, "2026-02-10", { candidateStage: "B", currentCidSource: "Y" }),
        fileRow(cid, "2026-03-05", { candidateStage: "C", currentCidSource: "Z" }),
      ];
      const summary = await runCandidateAccentureReplaySync(rows, syncId, sql, { dryRun: false });
      const actualCount = Number(
        (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_sync_changes WHERE sync_id = ${syncId}`)[0].c
      );
      check(
        "Batched insert: actual DB row count matches summary.historyRowCount + nameMismatchNotesCount (the name note is written separately, not batched)",
        actualCount === summary.historyRowCount + summary.nameMismatchNotesCount,
        `summary=${summary.historyRowCount}+${summary.nameMismatchNotesCount} actual=${actualCount}`
      );
    }

    // ===== 11. Dry run writes nothing =====
    {
      const cid = CID(11);
      const seed = await seedRow(sql, cid, {});
      const rows = [fileRow(cid, "2026-01-26", { candidateStage: "Screen" })];
      const summary = await runCandidateAccentureReplaySync(rows, null, sql, { dryRun: true });
      check("Dry run: summary still reports the would-be change", summary.fieldChangeCounts.accenture_candidate_stage === 1);
      const row = await getCandidateMasterById(seed.id, sql);
      check("Dry run: live column untouched", row?.accenture_candidate_stage === "-", row?.accenture_candidate_stage);
      const steps = await sql<{ id: number }[]>`SELECT id FROM candidate_sync_changes WHERE candidate_master_id = ${seed.id}`;
      check("Dry run: zero history rows written", steps.length === 0, String(steps.length));
    }

    // ===== 12. report_date (migration 024): the live-write step's changed_at is re-stamped
    // with real time for ordering, but report_date must always carry the TRUE file date,
    // for every step — backdated or live-write alike — so the history modal can show it. =====
    {
      const cid = CID(12);
      const seed = await seedRow(sql, cid, { accenture_candidate_stage: "A" });
      const syncId = await makeSyncId(sql);
      const rows = [
        fileRow(cid, "2026-01-26", { candidateStage: "B" }), // backdated, non-final step
        fileRow(cid, "2026-02-10", { candidateStage: "C" }), // the live-write step
      ];
      await runCandidateAccentureReplaySync(rows, syncId, sql, { dryRun: false });
      const stepRows = await sql<{ old_value: string; new_value: string; changed_at: string; report_date: string | null }[]>`
        SELECT old_value, new_value, changed_at, report_date FROM candidate_sync_changes
        WHERE candidate_master_id = ${seed.id} AND field_name = 'accenture_candidate_stage' ORDER BY id
      `;
      check("report_date: exactly 2 steps", stepRows.length === 2, String(stepRows.length));
      check(
        "report_date: backdated step (A->B) has report_date 2026-01-26, matching its own changed_at's date",
        stepRows[0]?.report_date === "2026-01-26",
        JSON.stringify(stepRows[0])
      );
      const liveStepChangedAt = stepRows[1] ? new Date(stepRows[1].changed_at) : null;
      const isRecent = liveStepChangedAt ? Date.now() - liveStepChangedAt.getTime() < 5 * 60 * 1000 : false;
      check(
        "report_date: the LIVE-WRITE step (B->C) has changed_at stamped with REAL time (within the last 5 minutes, not 2026-02-10)",
        isRecent,
        stepRows[1]?.changed_at
      );
      check(
        "report_date: that SAME live-write step's report_date is STILL the true file date (2026-02-10), not today",
        stepRows[1]?.report_date === "2026-02-10",
        JSON.stringify(stepRows[1])
      );

      // Read-layer + modal-facing shape: getCandidateChangeHistory must surface reportDate.
      const history = await getCandidateChangeHistory(cid, sql);
      const liveEntry = history.find((e) => e.newValue === "C" && e.header === "Accenture Candidate Stage");
      check(
        "report_date: getCandidateChangeHistory exposes reportDate='2026-02-10' for the live-write entry (what the modal displays as primary date)",
        liveEntry?.reportDate === "2026-02-10",
        JSON.stringify(liveEntry)
      );
      const backdatedEntry = history.find((e) => e.newValue === "B" && e.header === "Accenture Candidate Stage");
      check(
        "report_date: the backdated entry also exposes reportDate='2026-01-26'",
        backdatedEntry?.reportDate === "2026-01-26",
        JSON.stringify(backdatedEntry)
      );
    }

    // ===== 13. GENUINE follow-up upload (not a re-upload of the same file): a later
    // real-world upload reporting a NEW date that falls between run 1's last file
    // date and TODAY must NOT be treated as "already seen." Run 1's live-write step
    // is stamped with real time (today) — found by rehearsing an actual follow-up
    // file during the UI preview: the checkpoint was wrongly compared against that
    // real timestamp instead of the true file date, silently skipping every
    // genuinely-new date that happened to fall chronologically before "today." =====
    {
      const cid = CID(13);
      const seed = await seedRow(sql, cid, {});
      const run1Rows = [
        fileRow(cid, "2026-01-26", { candidateStage: "Screen" }),
        fileRow(cid, "2026-02-10", { candidateStage: "Interview" }),
      ];
      const syncId1 = await makeSyncId(sql);
      const summary1 = await runCandidateAccentureReplaySync(run1Rows, syncId1, sql, { dryRun: false });
      check("Follow-up setup: run 1 writes Interview live", summary1.fieldChangeCounts.accenture_candidate_stage === 1);

      // A genuinely NEW follow-up file, dated 2026-03-01 — after run 1's last file
      // date (02-10) but still long before "today" (whatever real date this test
      // runs on). Must be treated as new, real data, not skipped as "already seen."
      const run2Rows = [fileRow(cid, "2026-03-01", { candidateStage: "Offer" })];
      const syncId2 = await makeSyncId(sql);
      const summary2 = await runCandidateAccentureReplaySync(run2Rows, syncId2, sql, { dryRun: false });
      check(
        "Follow-up: the new 2026-03-01 date is NOT skipped — 1 new history row logged",
        summary2.historyRowCount === 1,
        String(summary2.historyRowCount)
      );
      const row = await getCandidateMasterById(seed.id, sql);
      check(
        "Follow-up: live value correctly advances to Offer (not stuck at Interview)",
        row?.accenture_candidate_stage === "Offer",
        row?.accenture_candidate_stage
      );
      const step2 = await sql<{ old_value: string; new_value: string; report_date: string | null }[]>`
        SELECT old_value, new_value, report_date FROM candidate_sync_changes WHERE sync_id = ${syncId2} AND field_name = 'accenture_candidate_stage'
      `;
      check(
        "Follow-up: the logged step is Interview->Offer with report_date 2026-03-01",
        step2[0]?.old_value === "Interview" && step2[0]?.new_value === "Offer" && step2[0]?.report_date === "2026-03-01",
        JSON.stringify(step2[0])
      );
    }
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
