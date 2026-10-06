/**
 * Stage 3 validation — the violet highlight/hover module
 * (read-candidate-accenture-highlights.ts), its wiring into
 * candidate-master-sheet-postgres.ts (filters + page-scoped highlight
 * state), and the history modal's new kind/ordering (read-candidate-highlights.ts).
 *
 * DESTRUCTIVE — writes to candidate_master / candidate_sync_history /
 * candidate_sync_changes / candidate_review_flags / lateral_master.
 * Throwaway/test DB only. Every row uses a CID unique to this run, cleaned
 * up in `finally`.
 *
 * Run: npx tsx scripts/verify-candidate-accenture-highlights.ts
 */
import { closeDbClient, getDbClient } from "../src/lib/persistence/db-client";
import {
  getCandidateMasterById,
  getCandidateMasterRowsByCid,
  type SqlClient,
} from "../src/services/persistence/read-candidate-master";
import {
  getAccentureChangedFieldsForRun,
  getAccentureHoverData,
  getAccentureUploadSyncIds,
  getCidsInsertedByRun,
  getLatestSuccessfulAccentureRun,
} from "../src/services/persistence/read-candidate-accenture-highlights";
import { getCandidateChangeHistory } from "../src/services/persistence/read-candidate-highlights";
import { runCandidateAccentureSync } from "../src/services/candidate-processing/candidate-accenture-engine";
import type { CandidateAccentureParsedRow } from "../src/services/candidate-processing/candidate-accenture-parser";
import { queryCandidateMasterSheetPage } from "../src/services/persistence/candidate-master-sheet-postgres";
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

function fileRow(cid: string, overrides: Partial<CandidateAccentureParsedRow> = {}): CandidateAccentureParsedRow {
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
  overrides: Partial<{ name: string; email: string }> = {}
) {
  cidsUsed.push(cid);
  await sql`
    INSERT INTO candidate_master (
      cid, name, gender, contact_number, date_of_upload, submitter, customer,
      job_requisition_id, primary_skills, job_management_level, market,
      client_spoc, status, accenture_candidate_stage, current_cid_source,
      application_completion_status, screening_candidate_stage, disposition_reason,
      submitted_date, submission_comments, email
    ) VALUES (
      ${cid}, ${overrides.name ?? "Seed Name"}, '-', '-', '-', '-', '-',
      '-', '-', '-', '-',
      '-', '-', '-', '-',
      '-', '-', '-',
      '-', '-', ${overrides.email ?? "-"}
    )
  `;
  const [row] = await getCandidateMasterRowsByCid(cid, sql);
  return row;
}

async function makeAccentureSyncId(sql: SqlClient, result: "success" | "failed" = "success"): Promise<number> {
  const [{ id }] = await sql<{ id: number }[]>`
    INSERT INTO candidate_sync_history (started_at, result, kind, source_filename)
    VALUES (NOW(), ${result}, 'accenture_upload', 'test-accenture.xlsx') RETURNING id
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
      `candidate_master has ${existingCount} rows — refusing to run this destructive test against what looks like real data.`
    );
  }

  try {
    // ===== 1. Chain previous-value = value BEFORE the run (earliest step), not the last step's old value =====
    {
      const cid = CID(1);
      await seedRow(sql, cid, { email: "stored@x.com" });
      const syncId = await makeAccentureSyncId(sql);
      const rows = [fileRow(cid, { email: "a@x.com" }), fileRow(cid, { email: "b@x.com" }), fileRow(cid, { email: "c@x.com" })];
      await runCandidateAccentureSync(rows, syncId, sql, { dryRun: false });

      const hover = await getAccentureHoverData([cid], sql);
      const emailHover = hover.get(cid)?.get("email");
      check(
        "Chain A,B,C: hover previousValue is the value BEFORE the run (stored@x.com), not the last step's old value (b@x.com)",
        emailHover?.previousValue === "stored@x.com",
        emailHover?.previousValue ?? "undefined"
      );
      check("Chain: hover isAccentureLatest is true", emailHover?.isAccentureLatest === true);

      const changedFields = await getAccentureChangedFieldsForRun(syncId, sql);
      check("Chain: violet cells for this CID include email", changedFields.get(cid)?.has("email") === true);
    }

    // ===== 2. Latest successful run only; a FAILED run never counts =====
    {
      const cid = CID(2);
      await seedRow(sql, cid, { email: "before@x.com" });
      const successSyncId = await makeAccentureSyncId(sql, "success");
      await runCandidateAccentureSync([fileRow(cid, { email: "after@x.com" })], successSyncId, sql, { dryRun: false });

      const failedSyncId = await makeAccentureSyncId(sql, "failed");
      // A failed run's own transaction would have rolled back in real life (Stage 2's
      // job wrapper) — simulate the DB state that results (the failed history row
      // exists, but it never wrote any candidate_sync_changes/update of its own).

      const latest = await getLatestSuccessfulAccentureRun(sql);
      check(
        "Latest successful run is the SUCCESS one, not the later FAILED one (failed never counts)",
        latest?.id === successSyncId,
        JSON.stringify({ latest: latest?.id, success: successSyncId, failed: failedSyncId })
      );
    }

    // ===== 3. New Rows filter: permanent, survives a later unrelated Accenture run =====
    {
      const cidNew = CID(3);
      cidsUsed.push(cidNew); // inserted fresh by the engine itself, never via seedRow
      const run1 = await makeAccentureSyncId(sql);
      await runCandidateAccentureSync([fileRow(cidNew, { name: "New Row", email: "new@x.com" })], run1, sql, { dryRun: false });
      const run1InsertedCids = await getCidsInsertedByRun(run1, sql);
      check("New Rows: inserted CID appears in run1's own inserted set", run1InsertedCids.has(cidNew));

      // A second, LATER Accenture run that does NOT touch cidNew at all.
      const otherCid = CID(4);
      await seedRow(sql, otherCid, { email: "unrelated@x.com" });
      const run2 = await makeAccentureSyncId(sql);
      await runCandidateAccentureSync([fileRow(otherCid, { email: "unrelated-changed@x.com" })], run2, sql, { dryRun: false });

      const allAccentureSyncIds = await getAccentureUploadSyncIds(sql);
      const row = await getCandidateMasterRowsByCid(cidNew, sql);
      check(
        "New Rows: PERMANENT — cidNew's inserted_sync_id (run1) is still in the all-time Accenture sync id set after a later, unrelated run2",
        row[0]?.inserted_sync_id != null && allAccentureSyncIds.has(row[0].inserted_sync_id),
        JSON.stringify({ insertedSyncId: row[0]?.inserted_sync_id, run1, run2 })
      );

      // "Latest Upload" (bounded, not permanent) should now point at run2, NOT run1.
      const latest = await getLatestSuccessfulAccentureRun(sql);
      check("Latest Upload now points at run2 (the newer run), not run1", latest?.id === run2, String(latest?.id));
    }

    // ===== 4. Name mismatch: violet highlight + hover note; disappears once corrected =====
    {
      const cid = CID(5);
      const seeded = await seedRow(sql, cid, { name: "Original Name" });
      const syncId = await makeAccentureSyncId(sql);
      await runCandidateAccentureSync([fileRow(cid, { name: "Different Name" })], syncId, sql, { dryRun: false });

      const changedFields = await getAccentureChangedFieldsForRun(syncId, sql);
      check("Name mismatch: 'name' appears in the run's changed-fields set", changedFields.get(cid)?.has("name") === true);
      const hoverBefore = await getAccentureHoverData([cid], sql);
      const nameHoverBefore = hoverBefore.get(cid)?.get("name");
      check(
        "Name mismatch hover: isAccentureLatest true, fileReportedValue = 'Different Name'",
        nameHoverBefore?.isAccentureLatest === true && nameHoverBefore?.fileReportedValue === "Different Name",
        JSON.stringify(nameHoverBefore)
      );

      // Correct the name via manual edit to MATCH the file's reported name.
      const fullOriginal: CandidateManualFieldValues = {
        cid: seeded.cid, date_of_upload: "-", name: "Original Name", email: seeded.email,
        contact_number: "-", submitter: "-", customer: "-", job_requisition_id: "-",
        primary_skills: "-", job_management_level: "-", market: "-", client_spoc: "-", status: "-",
        accenture_candidate_stage: "-", current_cid_source: "-", application_completion_status: "-",
        screening_candidate_stage: "-", disposition_reason: "-", submitted_date: "-",
        submission_comments: "-", gender: "-",
      };
      await updateCandidateManualRow(
        seeded.id,
        { ...fullOriginal, name: "Different Name" },
        null,
        fullOriginal,
        "verify-script@example.com",
        sql
      );

      const hoverAfter = await getAccentureHoverData([cid], sql);
      const nameHoverAfter = hoverAfter.get(cid)?.get("name");
      check(
        "Name mismatch, corrected: hover isAccentureLatest is now FALSE (the manual edit is the new latest write for 'name')",
        nameHoverAfter?.isAccentureLatest === false,
        JSON.stringify(nameHoverAfter)
      );

      // Full page-level check: the violet highlight for 'Name' must be gone too.
      const page = await queryCandidateMasterSheetPage(
        { page: 1, pageSize: 50, columnFilters: {}, textFilters: {}, dateFilters: {} },
        sql
      );
      const stillViolet = page.highlights.accentureCellsByCid[cid]?.includes("Name") ?? false;
      check("Name mismatch, corrected: 'Name' no longer appears in the page's violet accentureCellsByCid", !stillViolet);
    }

    // ===== 5. Hover reverts to plain after a later manual edit on a synced field, while the lock stays TRUE =====
    {
      const cid = CID(6);
      const seeded = await seedRow(sql, cid, { email: "stored@x.com" });
      const syncId = await makeAccentureSyncId(sql);
      await runCandidateAccentureSync([fileRow(cid, { email: "accenture-set@x.com" })], syncId, sql, { dryRun: false });

      const afterAccenture = await getCandidateMasterById(seeded.id, sql);
      check("Lock set TRUE by the Accenture run", afterAccenture?.email_accenture_locked === true);

      const hoverBefore = await getAccentureHoverData([cid], sql);
      check("Before manual edit: hover IS Accenture-latest", hoverBefore.get(cid)?.get("email")?.isAccentureLatest === true);
      const pageBefore = await queryCandidateMasterSheetPage(
        { page: 1, pageSize: 50, columnFilters: {}, textFilters: {}, dateFilters: {} },
        sql
      );
      check(
        "Before manual edit: Email IS in the page's violet accentureCellsByCid",
        pageBefore.highlights.accentureCellsByCid[cid]?.includes("Email") ?? false
      );

      const fullOriginal: CandidateManualFieldValues = {
        cid: seeded.cid, date_of_upload: "-", name: seeded.name, email: "accenture-set@x.com",
        contact_number: "-", submitter: "-", customer: "-", job_requisition_id: "-",
        primary_skills: "-", job_management_level: "-", market: "-", client_spoc: "-", status: "-",
        accenture_candidate_stage: "-", current_cid_source: "-", application_completion_status: "-",
        screening_candidate_stage: "-", disposition_reason: "-", submitted_date: "-",
        submission_comments: "-", gender: "-",
      };
      await updateCandidateManualRow(
        seeded.id,
        { ...fullOriginal, email: "manually-overridden@x.com" },
        null,
        fullOriginal,
        "verify-script@example.com",
        sql
      );

      const afterManual = await getCandidateMasterById(seeded.id, sql);
      check("Manual edit after Accenture: the lock STAYS TRUE (manual edit never touches it)", afterManual?.email_accenture_locked === true);
      check("Manual edit after Accenture: the value DID save", afterManual?.email === "manually-overridden@x.com");

      const hoverAfter = await getAccentureHoverData([cid], sql);
      check(
        "After manual edit: hover reverts to plain (isAccentureLatest false — the manual edit is now the latest write)",
        hoverAfter.get(cid)?.get("email")?.isAccentureLatest === false
      );

      // The fix under test: the violet CELL must now agree with the hover —
      // this assertion FAILS on the pre-fix code (Email stayed violet forever
      // once any Accenture run had touched it, with no check that Accenture
      // was still the latest writer for this specific cell).
      const pageAfter = await queryCandidateMasterSheetPage(
        { page: 1, pageSize: 50, columnFilters: {}, textFilters: {}, dateFilters: {} },
        sql
      );
      check(
        "After manual edit: Email is NO LONGER in the page's violet accentureCellsByCid (color now agrees with hover)",
        !(pageAfter.highlights.accentureCellsByCid[cid]?.includes("Email") ?? false)
      );
    }

    // ===== 5b. Same staleness check on job_management_level — confirms the fix is general, not email-specific =====
    {
      const cid = CID(90);
      const seeded = await seedRow(sql, cid, { email: "-" });
      await sql`UPDATE candidate_master SET job_management_level = '-' WHERE id = ${seeded.id}`;
      const syncId = await makeAccentureSyncId(sql);
      await runCandidateAccentureSync([fileRow(cid, { level: "CL8" })], syncId, sql, { dryRun: false });

      const pageBefore = await queryCandidateMasterSheetPage(
        { page: 1, pageSize: 50, columnFilters: {}, textFilters: {}, dateFilters: {} },
        sql
      );
      check(
        "job_management_level, before manual edit: violet",
        pageBefore.highlights.accentureCellsByCid[cid]?.includes("Job Management Level") ?? false
      );

      const fullOriginal: CandidateManualFieldValues = {
        cid: seeded.cid, date_of_upload: "-", name: seeded.name, email: "-",
        contact_number: "-", submitter: "-", customer: "-", job_requisition_id: "-",
        primary_skills: "-", job_management_level: "CL8", market: "-", client_spoc: "-", status: "-",
        accenture_candidate_stage: "-", current_cid_source: "-", application_completion_status: "-",
        screening_candidate_stage: "-", disposition_reason: "-", submitted_date: "-",
        submission_comments: "-", gender: "-",
      };
      await updateCandidateManualRow(
        seeded.id,
        { ...fullOriginal, job_management_level: "CL9" },
        null,
        fullOriginal,
        "verify-script@example.com",
        sql
      );

      const pageAfter = await queryCandidateMasterSheetPage(
        { page: 1, pageSize: 50, columnFilters: {}, textFilters: {}, dateFilters: {} },
        sql
      );
      check(
        "job_management_level, after manual edit: no longer violet (same fix, different field)",
        !(pageAfter.highlights.accentureCellsByCid[cid]?.includes("Job Management Level") ?? false)
      );
    }

    // ===== 5c. Regression guard: a field with NO later write stays violet (the fix must not over-correct) =====
    {
      const cid = CID(91);
      await seedRow(sql, cid, { email: "untouched-after@x.com" });
      const syncId = await makeAccentureSyncId(sql);
      await runCandidateAccentureSync([fileRow(cid, { email: "untouched-after@x.com", candidateStage: "On Hold" })], syncId, sql, { dryRun: false });
      // No manual edit at all.
      const page = await queryCandidateMasterSheetPage(
        { page: 1, pageSize: 50, columnFilters: {}, textFilters: {}, dateFilters: {} },
        sql
      );
      check(
        "No manual edit: the touched field stays violet (regression guard — the fix doesn't remove fields that are genuinely still Accenture-latest)",
        page.highlights.accentureCellsByCid[cid]?.includes("Accenture Candidate Stage") ?? false
      );
    }

    // ===== 5d. The new-row Candidate ID tint is a SEPARATE mechanism (accentureInsertedCids) and is unaffected by the fix =====
    {
      const cid = CID(92);
      cidsUsed.push(cid);
      const syncId = await makeAccentureSyncId(sql);
      await runCandidateAccentureSync([fileRow(cid, { email: "brand-new-row@x.com" })], syncId, sql, { dryRun: false });
      const page = await queryCandidateMasterSheetPage(
        { page: 1, pageSize: 50, columnFilters: {}, textFilters: {}, dateFilters: {} },
        sql
      );
      check(
        "New row: Candidate ID tint (accentureInsertedCids) still fires — unaffected by the latest-writer fix",
        page.highlights.accentureInsertedCids.includes(cid)
      );
    }

    // ===== 6. Violet window is independent of the Oorwin window (no shared code, no shared CIDs needed) =====
    {
      const cid = CID(7);
      await seedRow(sql, cid, { email: "oorwin-will-touch@x.com" });
      const accentureSyncId = await makeAccentureSyncId(sql);
      // A DIFFERENT CID touched only by Accenture (not Oorwin).
      const accentureOnlyCid = CID(8);
      await seedRow(sql, accentureOnlyCid, { email: "accenture-only-before@x.com" });
      await runCandidateAccentureSync([fileRow(accentureOnlyCid, { email: "accenture-only-after@x.com" })], accentureSyncId, sql, { dryRun: false });

      const { runCandidateSync } = await import("../src/services/candidate-processing/candidate-sync-engine");
      const [{ id: oorwinSyncId }] = await sql<{ id: number }[]>`
        INSERT INTO candidate_sync_history (started_at, result, kind, source_filename, triggered_by)
        VALUES (NOW(), 'success', 'oorwin_upload', 'independence-test.xls', 'verify-script@example.com') RETURNING id
      `;
      syncIdsUsed.push(Number(oorwinSyncId));
      await runCandidateSync(
        [
          {
            sheetRowNumber: 1, cid, firstName: "Oorwin", middleName: "-", lastName: "Touch", email: "oorwin-touched@x.com",
            mobile: "-", gender: "-", submitter: "-", customer: "-", clientSubmissionJr: "-", customerJobTitle: "-",
            market: "-", clientSpoc: "-", status: "-", submittedDate: "-", reasonForRejection: "-", submissionComments: "-",
          },
        ],
        Number(oorwinSyncId),
        sql
      );

      const page = await queryCandidateMasterSheetPage(
        { page: 1, pageSize: 100, columnFilters: {}, textFilters: {}, dateFilters: {} },
        sql
      );
      const oorwinCidEmerald = page.highlights.changedCellsByCid[cid]?.includes("Email") ?? false;
      const oorwinCidViolet = page.highlights.accentureCellsByCid[cid]?.includes("Email") ?? false;
      const accentureOnlyEmerald = page.highlights.changedCellsByCid[accentureOnlyCid]?.includes("Email") ?? false;
      const accentureOnlyViolet = page.highlights.accentureCellsByCid[accentureOnlyCid]?.includes("Email") ?? false;
      check(
        "Independence: the Oorwin-touched CID shows emerald but NOT violet for Email",
        oorwinCidEmerald && !oorwinCidViolet,
        JSON.stringify({ oorwinCidEmerald, oorwinCidViolet })
      );
      check(
        "Independence: the Accenture-only CID shows violet but NOT emerald for Email (it predates/excludes the Oorwin window)",
        accentureOnlyViolet && !accentureOnlyEmerald,
        JSON.stringify({ accentureOnlyEmerald, accentureOnlyViolet })
      );
    }

    // ===== 7. Precedence: amber beats violet. Seed a row that is BOTH review-flagged AND Accenture-touched. =====
    {
      const cid = CID(9);
      await seedRow(sql, cid); // job_requisition_id blank "-" -> will get missing_job_requisition_id flag via Add path if used; simpler: write a flag directly.
      const syncId = await makeAccentureSyncId(sql);
      await runCandidateAccentureSync([fileRow(cid, { email: "flagged-and-violet@x.com" })], syncId, sql, { dryRun: false });
      await sql`INSERT INTO candidate_review_flags (sync_id, cid, reason, detail) VALUES (${syncId}, ${cid}, 'missing_job_requisition_id', '{}'::jsonb)`;

      const page = await queryCandidateMasterSheetPage(
        { page: 1, pageSize: 100, columnFilters: {}, textFilters: {}, dateFilters: {} },
        sql
      );
      const isViolet = page.highlights.accentureCellsByCid[cid]?.includes("Email") ?? false;
      const flagged = page.highlights.fieldFlagsByCid[cid]?.some((f) => f.header === "Job Requisition ID") ?? false;
      check("Precedence setup: row is both Accenture-touched (Email, violet-eligible) and flagged (JR ID, amber)", isViolet && flagged, JSON.stringify({ isViolet, flagged }));
      // (Amber/violet precedence itself is rendered client-side in the table component — confirmed by code inspection: `fieldFlag ? amber : isAccentureCell ? violet : isChanged && emerald`, amber always wins when both apply to the SAME cell. This check confirms the underlying data both exist simultaneously so that precedence logic is actually exercised, not vacuously true.)
    }

    // ===== 8. History modal: kind label + ordering (changed_at DESC, id DESC) + Accenture name-mismatch rendering =====
    {
      const cid = CID(10);
      await seedRow(sql, cid, { email: "s@x.com", name: "Chain Name" });
      const syncId = await makeAccentureSyncId(sql);
      await runCandidateAccentureSync(
        [fileRow(cid, { email: "a@x.com" }), fileRow(cid, { email: "b@x.com" }), fileRow(cid, { name: "New Name", email: "c@x.com" })],
        syncId,
        sql,
        { dryRun: false }
      );
      const history = await getCandidateChangeHistory(cid, sql);
      const emailEntries = history.filter((e) => e.header === "Email");
      check("History: 3 email steps recorded for the chain", emailEntries.length === 3, String(emailEntries.length));
      check(
        "History ordering: changed_at DESC, id DESC — newest step (b->c) comes FIRST",
        emailEntries[0]?.oldValue === "b@x.com" && emailEntries[0]?.newValue === "c@x.com",
        JSON.stringify(emailEntries.map((e) => `${e.oldValue}->${e.newValue}`))
      );
      check("History: email entries are kindLabel 'Accenture Final Report upload'", emailEntries.every((e) => e.kindLabel === "Accenture Final Report upload"));
      const nameEntry = history.find((e) => e.header === "Name");
      check(
        "History: the Name entry is flagged isAccentureNameMismatch",
        nameEntry?.isAccentureNameMismatch === true,
        JSON.stringify(nameEntry)
      );
    }

    console.log("\n========== TEST RESULTS ==========");
    let failures = 0;
    for (const r of results) {
      console.log(`[${r.status}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
      if (r.status === "FAIL") failures += 1;
    }
    console.log(`\n${results.length - failures}/${results.length} passed.`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    await sql`DELETE FROM candidate_review_flags WHERE cid = ANY(${cidsUsed})`;
    if (syncIdsUsed.length > 0) {
      await sql`DELETE FROM candidate_review_flags WHERE sync_id = ANY(${syncIdsUsed})`;
    }
    await sql`DELETE FROM candidate_sync_changes WHERE cid = ANY(${cidsUsed})`;
    await sql`DELETE FROM candidate_master WHERE cid = ANY(${cidsUsed})`;
    if (syncIdsUsed.length > 0) {
      await sql`DELETE FROM candidate_sync_history WHERE id = ANY(${syncIdsUsed})`;
    }
    await closeDbClient();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
