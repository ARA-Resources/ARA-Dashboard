/**
 * Migration 021 validation — manual Add/Modify/Delete, the Oorwin dup-CID
 * fix, the "Recently changed" window fix, and the hard-delete purge.
 *
 * DESTRUCTIVE — writes to candidate_master / candidate_sync_history /
 * candidate_sync_changes / candidate_review_flags / lateral_master /
 * executive_master. Only ever run this against a throwaway/test database,
 * never prod. Every row this script creates uses a CID/JR prefix unique to
 * this run and is deleted in a `finally` block, success or failure.
 *
 * Run: npx tsx scripts/verify-candidate-manual-edit.ts
 */
import { closeDbClient, getDbClient } from "../src/lib/persistence/db-client";
import {
  findLiveCandidateRowsByCid,
  insertCandidateManualRow,
  mergeManualValuesOntoExistingRow,
  softDeleteCandidateManualRow,
  updateCandidateManualRow,
  validateCandidateManualInput,
  type CandidateManualFieldValues,
} from "../src/services/candidate-processing/candidate-manual-edit";
import {
  getCandidateMasterById,
  getCandidateMasterRowsByCid,
  listCandidateMasterRows,
  type CandidateMasterRow,
} from "../src/services/persistence/read-candidate-master";
import {
  getCandidateRecentChangeWindowSyncIds,
  getLatestCandidateChangedFields,
} from "../src/services/persistence/read-candidate-highlights";
import { queryCandidateMasterSheetPage } from "../src/services/persistence/candidate-master-sheet-postgres";
import { runCandidateSync } from "../src/services/candidate-processing/candidate-sync-engine";
import type { CandidateOorwinParsedRow } from "../src/services/candidate-processing/candidate-oorwin-parser";
import { resolveCandidateAutoFetchFields } from "../src/services/candidate-processing/candidate-auto-fetch";
import { runCandidatePurge } from "../src/services/candidate-processing/candidate-purge-scheduler";

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
}

function check(results: TestResult[], name: string, pass: boolean, detail?: string) {
  results.push({ name, status: pass ? "PASS" : "FAIL", detail });
}

const RUN_ID = Date.now();
const CID = (n: number) => `C9${RUN_ID}${n}`;
const JR = (label: string) => `TEST-CME-${RUN_ID}-${label}`;

function sheetRow(partial: Partial<CandidateOorwinParsedRow> & { cid: string }): CandidateOorwinParsedRow {
  return {
    firstName: "Sheet",
    middleName: "-",
    lastName: "Row",
    email: "-",
    mobile: "-",
    gender: "-",
    submitter: "-",
    customer: "-",
    clientSubmissionJr: JR("DEFAULT"),
    customerJobTitle: "-",
    market: "-",
    clientSpoc: "-",
    status: "-",
    submittedDate: "-",
    reasonForRejection: "-",
    submissionComments: "-",
    sheetRowNumber: 1,
    ...partial,
  };
}

/**
 * Mirrors candidate-row-form-modal.tsx's `rowToValues` — the client's own
 * snapshot of a loaded row, where a stored "-" (blank) renders as "" in the
 * form. This is what the client actually sends back as `original` on Modify,
 * NOT the raw "-"-shaped DB row the rest of this script's other snapshots use.
 */
function clientShapedSnapshot(row: CandidateMasterRow): CandidateManualFieldValues {
  const raw: Record<string, string> = {
    cid: row.cid,
    date_of_upload: row.date_of_upload,
    name: row.name,
    email: row.email,
    contact_number: row.contact_number,
    submitter: row.submitter,
    customer: row.customer,
    job_requisition_id: row.job_requisition_id,
    primary_skills: row.primary_skills,
    job_management_level: row.job_management_level,
    market: row.market,
    client_spoc: row.client_spoc,
    status: row.status,
    accenture_candidate_stage: row.accenture_candidate_stage,
    current_cid_source: row.current_cid_source,
    application_completion_status: row.application_completion_status,
    screening_candidate_stage: row.screening_candidate_stage,
    disposition_reason: row.disposition_reason,
    submitted_date: row.submitted_date,
    submission_comments: row.submission_comments,
    gender: row.gender,
  };
  const out: Record<string, string> = {};
  for (const [field, value] of Object.entries(raw)) {
    out[field] = value === "-" ? "" : value;
  }
  return out as CandidateManualFieldValues;
}

function fullValues(overrides: Partial<CandidateManualFieldValues> & { cid: string; name: string }): Record<string, string> {
  return {
    date_of_upload: "",
    email: "",
    contact_number: "",
    submitter: "",
    customer: "",
    job_requisition_id: "",
    primary_skills: "",
    job_management_level: "",
    market: "",
    client_spoc: "",
    status: "",
    accenture_candidate_stage: "",
    current_cid_source: "",
    application_completion_status: "",
    screening_candidate_stage: "",
    disposition_reason: "",
    submitted_date: "",
    submission_comments: "",
    gender: "",
    ...overrides,
  };
}

async function main() {
  const results: TestResult[] = [];
  const sql = getDbClient();
  const testCids = [CID(1), CID(2), CID(3), CID(4), CID(5), CID(6), CID(7), CID(8), CID(9)];
  const testJrs = [
    JR("DEFAULT"),
    JR("A"),
    JR("B"),
    JR("LATERAL-ONLY"),
    JR("BOTH-AGREE"),
    JR("BOTH-CONFLICT"),
    JR("NOT-FOUND"),
  ];

  try {
    // ===== Seed lateral_master / executive_master for the JR resolver checks =====
    await sql`
      INSERT INTO lateral_master (job_requisition_id, primary_skills, job_management_level, market_map, poc)
      VALUES
        (${JR("LATERAL-ONLY")}, 'Lateral Skill', '8-Associate Manager', 'Lateral Market', 'Lateral SPOC'),
        (${JR("BOTH-AGREE")}, 'Shared Skill', 'Shared Level', 'Shared Market', 'Lateral SPOC'),
        (${JR("BOTH-CONFLICT")}, 'Lateral Skill', 'Lateral Level', 'Lateral Market', 'Lateral SPOC'),
        (${JR("A")}, 'JR-A Skill', 'JR-A Level', 'JR-A Market', 'JR-A SPOC'),
        (${JR("B")}, 'JR-B Skill', 'JR-B Level', 'JR-B Market', 'JR-B SPOC')
      ON CONFLICT (job_requisition_id) DO NOTHING
    `;
    await sql`
      INSERT INTO executive_master (job_requisition_id, primary_skills, job_management_level, market_map)
      VALUES
        (${JR("BOTH-AGREE")}, 'Shared Skill', 'Shared Level', 'Shared Market'),
        (${JR("BOTH-CONFLICT")}, 'Executive Skill', 'Executive Level', 'Executive Market')
      ON CONFLICT (job_requisition_id) DO NOTHING
    `;

    // ===== 1. Add: insert, history row, change rows, last_touched_at, sort order =====
    const addResult = await insertCandidateManualRow(
      {
        cid: testCids[0],
        name: "Verify Add",
        email: "verify.add@example.com",
        contact_number: "9000000010",
        date_of_upload: "01/01/2026",
        submitter: "Sub",
        customer: "Cust",
        job_requisition_id: "-",
        primary_skills: "-",
        job_management_level: "-",
        market: "-",
        client_spoc: "-",
        status: "In Progress",
        accenture_candidate_stage: "-",
        current_cid_source: "-",
        application_completion_status: "-",
        screening_candidate_stage: "-",
        disposition_reason: "-",
        submitted_date: "-",
        submission_comments: "-",
        gender: "Male",
      },
      null,
      "verify-script@example.com"
    );
    check(results, "Add: row inserted with inserted_sync_id + last_touched_at", Boolean(addResult.row.inserted_sync_id) && Boolean(addResult.row.last_touched_at));

    const historyRow = await sql<{ kind: string; source_filename: string; triggered_by: string }[]>`
      SELECT kind, source_filename, triggered_by FROM candidate_sync_history WHERE id = ${addResult.historyId}
    `;
    check(
      results,
      "Add: candidate_sync_history kind=manual_add, source_filename=manual-add, triggered_by recorded",
      historyRow[0]?.kind === "manual_add" &&
        historyRow[0]?.source_filename === "manual-add" &&
        historyRow[0]?.triggered_by === "verify-script@example.com",
      JSON.stringify(historyRow[0])
    );

    const changeRows = await sql<{ field_name: string; old_value: string | null; candidate_master_id: number }[]>`
      SELECT field_name, old_value, candidate_master_id FROM candidate_sync_changes WHERE sync_id = ${addResult.historyId}
    `;
    // Non-"-" fields entered: cid, name, email, contact_number, date_of_upload, submitter, customer, status, gender = 9
    check(
      results,
      "Add: one change row per non-'-' field, old_value NULL, candidate_master_id set",
      changeRows.length === 9 &&
        changeRows.every((r) => r.old_value === null && Number(r.candidate_master_id) === addResult.row.id),
      `got ${changeRows.length} rows`
    );

    const listed = await listCandidateMasterRows(sql);
    check(
      results,
      "Add: new row sorts to (near) the top under last_touched_at DESC NULLS LAST",
      listed.length > 0 && listed[0].id === addResult.row.id
    );

    // ===== 2. Duplicate CID: add a second row sharing the same CID (a) =====
    const addDuplicateResult = await insertCandidateManualRow(
      {
        cid: testCids[0],
        name: "Verify Add Duplicate",
        email: "-",
        contact_number: "-",
        date_of_upload: "02/01/2026",
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
      },
      null,
      "verify-script@example.com"
    );
    const duplicatesAfterAdd = await findLiveCandidateRowsByCid(testCids[0], sql);
    check(results, "Duplicate CID: findLiveCandidateRowsByCid now returns 2 live rows", duplicatesAfterAdd.length === 2);

    const pageWithDuplicate = await queryCandidateMasterSheetPage(
      {
        page: 1,
        pageSize: 500,
        columnFilters: {},
        textFilters: {},
        dateFilters: {},
        highlightFilters: [],
        syncFilter: null,
      },
      sql
    );
    check(
      results,
      "Duplicate CID: live highlight (D2) flags the CID as duplicate_cid",
      (pageWithDuplicate.highlights.duplicateFlagCids[testCids[0]] ?? []).includes("duplicate_cid")
    );

    // ===== 3. mergeManualValuesOntoExistingRow (Add's "treat as existing", option b) =====
    const existingForMerge = await getCandidateMasterById(addResult.row.id, sql);
    if (!existingForMerge) throw new Error("existingForMerge row vanished");
    const merged = mergeManualValuesOntoExistingRow(
      { cid: testCids[0], name: "", email: "new@example.com", status: "" },
      existingForMerge
    );
    check(
      results,
      "mergeManualValuesOntoExistingRow: blank entered field keeps existing value, filled field overwrites",
      merged.name === existingForMerge.name &&
        merged.email === "new@example.com" &&
        merged.status === existingForMerge.status
    );

    // ===== 4. Modify: diff, candidate_master_id-scoped change row, last_touched_at =====
    const beforeModify = await getCandidateMasterById(addResult.row.id, sql);
    if (!beforeModify) throw new Error("beforeModify row vanished");
    const originalSnapshot = {
      cid: beforeModify.cid,
      date_of_upload: beforeModify.date_of_upload,
      name: beforeModify.name,
      email: beforeModify.email,
      contact_number: beforeModify.contact_number,
      submitter: beforeModify.submitter,
      customer: beforeModify.customer,
      job_requisition_id: beforeModify.job_requisition_id,
      primary_skills: beforeModify.primary_skills,
      job_management_level: beforeModify.job_management_level,
      market: beforeModify.market,
      client_spoc: beforeModify.client_spoc,
      status: beforeModify.status,
      accenture_candidate_stage: beforeModify.accenture_candidate_stage,
      current_cid_source: beforeModify.current_cid_source,
      application_completion_status: beforeModify.application_completion_status,
      screening_candidate_stage: beforeModify.screening_candidate_stage,
      disposition_reason: beforeModify.disposition_reason,
      submitted_date: beforeModify.submitted_date,
      submission_comments: beforeModify.submission_comments,
      gender: beforeModify.gender,
    } as CandidateManualFieldValues;

    const modifiedValues = { ...originalSnapshot, name: "Verify Add — Renamed" };
    const modifyOutcome = await updateCandidateManualRow(
      addResult.row.id,
      modifiedValues,
      null,
      originalSnapshot,
      "verify-script@example.com",
      sql
    );
    check(results, "Modify: outcome status ok", modifyOutcome.status === "ok", modifyOutcome.status);
    if (modifyOutcome.status === "ok") {
      check(
        results,
        "Modify: changedFields is exactly ['name']",
        modifyOutcome.result.changedFields.length === 1 && modifyOutcome.result.changedFields[0] === "name"
      );
      const modifyChangeRows = await sql<{ candidate_master_id: number; old_value: string | null; new_value: string | null }[]>`
        SELECT candidate_master_id, old_value, new_value FROM candidate_sync_changes WHERE sync_id = ${modifyOutcome.result.historyId}
      `;
      check(
        results,
        "Modify: change row scoped to this row's id only, correct old/new values",
        modifyChangeRows.length === 1 &&
          Number(modifyChangeRows[0].candidate_master_id) === addResult.row.id &&
          modifyChangeRows[0].old_value === "Verify Add" &&
          modifyChangeRows[0].new_value === "Verify Add — Renamed"
      );
      const modifyHistoryRow = await sql<{ kind: string }[]>`
        SELECT kind FROM candidate_sync_history WHERE id = ${modifyOutcome.result.historyId}
      `;
      check(results, "Modify: candidate_sync_history kind=manual_modify", modifyHistoryRow[0]?.kind === "manual_modify");
    }

    // The duplicate row (testCids[0], second insert) must be untouched by
    // this Modify — proves the row-id targeting (not WHERE cid=) fix.
    const untouchedDuplicate = await getCandidateMasterById(addDuplicateResult.row.id, sql);
    check(
      results,
      "Modify: the OTHER row sharing this CID is untouched (id-scoped update, not cid-scoped)",
      untouchedDuplicate?.name === "Verify Add Duplicate"
    );

    // ===== 5. Stale-edit guard =====
    const staleOutcome = await updateCandidateManualRow(
      addResult.row.id,
      { ...originalSnapshot, name: "Should Not Apply" },
      null,
      originalSnapshot, // stale: real current name is now "Verify Add — Renamed"
      "verify-script@example.com",
      sql
    );
    check(results, "Modify: stale original -> status 'stale'", staleOutcome.status === "stale");

    // ===== 5a. Crafted-request protection: lock columns / last_accenture_sync_id =====
    // Simulate "already touched by a prior Accenture upload" directly via SQL
    // (migration 022 columns, not yet writable by anything else), then try to
    // flip them through the real Modify path with a crafted payload carrying
    // those exact keys alongside one legitimate field change.
    await sql`
      UPDATE candidate_master SET
        email_accenture_locked = TRUE,
        job_management_level_accenture_locked = TRUE,
        last_accenture_sync_id = ${addResult.historyId}
      WHERE id = ${addResult.row.id}
    `;
    const lockedRowBefore = await getCandidateMasterById(addResult.row.id, sql);
    if (!lockedRowBefore) throw new Error("lockedRowBefore vanished");
    const craftedModifyRaw: Record<string, unknown> = {
      ...modifiedValues,
      customer: "Crafted Customer Change",
      // Not real CandidateManualFieldValues keys — a crafted/malicious client
      // trying to use the Modify endpoint to clear its own lock.
      email_accenture_locked: false,
      job_management_level_accenture_locked: false,
      last_accenture_sync_id: 999999,
    };
    const validatedCraftedModify = validateCandidateManualInput(craftedModifyRaw as Record<string, string>);
    if (!validatedCraftedModify.ok) throw new Error(`unexpected validation failure: ${validatedCraftedModify.error}`);
    check(
      results,
      "Crafted Modify request: validateCandidateManualInput's output never carries the 3 system keys (named-field extraction, not a spread)",
      !("email_accenture_locked" in validatedCraftedModify.values) &&
        !("job_management_level_accenture_locked" in validatedCraftedModify.values) &&
        !("last_accenture_sync_id" in validatedCraftedModify.values),
      JSON.stringify(Object.keys(validatedCraftedModify.values))
    );
    const craftedModifyOutcome = await updateCandidateManualRow(
      addResult.row.id,
      validatedCraftedModify.values,
      null,
      modifiedValues,
      "verify-script@example.com",
      sql
    );
    check(
      results,
      "Crafted Modify request: the legitimate field change (customer) still applies — status 'ok'",
      craftedModifyOutcome.status === "ok",
      craftedModifyOutcome.status
    );
    const lockedRowAfter = await getCandidateMasterById(addResult.row.id, sql);
    check(
      results,
      "Crafted Modify request: email_accenture_locked / job_management_level_accenture_locked / last_accenture_sync_id are UNCHANGED despite the crafted payload",
      lockedRowAfter?.email_accenture_locked === true &&
        lockedRowAfter?.job_management_level_accenture_locked === true &&
        lockedRowAfter?.last_accenture_sync_id === addResult.historyId &&
        lockedRowAfter?.customer === "Crafted Customer Change",
      JSON.stringify({
        email_accenture_locked: lockedRowAfter?.email_accenture_locked,
        job_management_level_accenture_locked: lockedRowAfter?.job_management_level_accenture_locked,
        last_accenture_sync_id: lockedRowAfter?.last_accenture_sync_id,
        customer: lockedRowAfter?.customer,
      })
    );

    // Same protection on Add: a crafted insert payload cannot pre-set the
    // lock/reference columns on a brand-new row either.
    const craftedAddRaw: Record<string, unknown> = {
      cid: testCids[8],
      name: "Crafted Add",
      email: "-",
      email_accenture_locked: true,
      job_management_level_accenture_locked: true,
      last_accenture_sync_id: addResult.historyId,
    };
    const validatedCraftedAdd = validateCandidateManualInput(craftedAddRaw as Record<string, string>);
    if (!validatedCraftedAdd.ok) throw new Error(`unexpected validation failure: ${validatedCraftedAdd.error}`);
    check(
      results,
      "Crafted Add request: validateCandidateManualInput's output never carries the 3 system keys",
      !("email_accenture_locked" in validatedCraftedAdd.values) &&
        !("job_management_level_accenture_locked" in validatedCraftedAdd.values) &&
        !("last_accenture_sync_id" in validatedCraftedAdd.values),
      JSON.stringify(Object.keys(validatedCraftedAdd.values))
    );
    const craftedAddResult = await insertCandidateManualRow(
      validatedCraftedAdd.values,
      null,
      "verify-script@example.com",
      sql
    );
    check(
      results,
      "Crafted Add request: the new row's lock/reference columns default to false/false/null regardless of the crafted payload",
      craftedAddResult.row.email_accenture_locked === false &&
        craftedAddResult.row.job_management_level_accenture_locked === false &&
        craftedAddResult.row.last_accenture_sync_id === null,
      JSON.stringify({
        email_accenture_locked: craftedAddResult.row.email_accenture_locked,
        job_management_level_accenture_locked: craftedAddResult.row.job_management_level_accenture_locked,
        last_accenture_sync_id: craftedAddResult.row.last_accenture_sync_id,
      })
    );

    // ===== 5b. Stale-edit guard: blank-normalization (the reported bug) =====
    // Insert a row with several blank fields — confirms (separately from
    // section 1's non-blank fields) that Add stores blanks as "-", not "".
    const blankRowResult = await insertCandidateManualRow(
      {
        cid: testCids[7],
        name: "Blank Normalize Row",
        email: "-",
        contact_number: "-",
        date_of_upload: "01/01/2026",
        submitter: "-",
        customer: "-",
        job_requisition_id: "-",
        primary_skills: "-",
        job_management_level: "-",
        market: "-",
        client_spoc: "-",
        status: "Old Status",
        accenture_candidate_stage: "-",
        current_cid_source: "-",
        application_completion_status: "-",
        screening_candidate_stage: "-",
        disposition_reason: "-",
        submitted_date: "-",
        submission_comments: "-",
        gender: "-",
      },
      null,
      "verify-script@example.com"
    );
    check(
      results,
      "Add: blank fields stored as '-', not ''",
      blankRowResult.row.email === "-" &&
        blankRowResult.row.contact_number === "-" &&
        blankRowResult.row.submitter === "-" &&
        blankRowResult.row.customer === "-" &&
        blankRowResult.row.job_requisition_id === "-" &&
        blankRowResult.row.primary_skills === "-" &&
        blankRowResult.row.job_management_level === "-" &&
        blankRowResult.row.market === "-" &&
        blankRowResult.row.client_spoc === "-" &&
        blankRowResult.row.submitted_date === "-" &&
        blankRowResult.row.submission_comments === "-" &&
        blankRowResult.row.gender === "-"
    );
    check(
      results,
      "Add: the 5 new Accenture columns, blank on input, are also stored as '-' (migration 022)",
      blankRowResult.row.accenture_candidate_stage === "-" &&
        blankRowResult.row.current_cid_source === "-" &&
        blankRowResult.row.application_completion_status === "-" &&
        blankRowResult.row.screening_candidate_stage === "-" &&
        blankRowResult.row.disposition_reason === "-",
      JSON.stringify({
        accenture_candidate_stage: blankRowResult.row.accenture_candidate_stage,
        current_cid_source: blankRowResult.row.current_cid_source,
        application_completion_status: blankRowResult.row.application_completion_status,
        screening_candidate_stage: blankRowResult.row.screening_candidate_stage,
        disposition_reason: blankRowResult.row.disposition_reason,
      })
    );
    check(
      results,
      "Add: a brand-new row's Accenture lock columns and last_accenture_sync_id default to false/false/null (never touched by Add)",
      blankRowResult.row.email_accenture_locked === false &&
        blankRowResult.row.job_management_level_accenture_locked === false &&
        blankRowResult.row.last_accenture_sync_id === null,
      JSON.stringify({
        email_accenture_locked: blankRowResult.row.email_accenture_locked,
        job_management_level_accenture_locked: blankRowResult.row.job_management_level_accenture_locked,
        last_accenture_sync_id: blankRowResult.row.last_accenture_sync_id,
      })
    );

    // The client's own snapshot of the freshly-loaded row (blanks as "") —
    // exactly what the modal sends back as `original`, unchanged.
    const blankClientOriginal = clientShapedSnapshot(blankRowResult.row);

    // (i) Unchanged blanks + one real field change -> must succeed, write
    // exactly one change row, and leave every still-blank field as "-".
    const blankChangedForm = { ...blankClientOriginal, status: "New Status" };
    const validatedBlankModify = validateCandidateManualInput(blankChangedForm);
    if (!validatedBlankModify.ok) throw new Error(`unexpected validation failure: ${validatedBlankModify.error}`);
    const changeRowsBeforeBlankModify = await sql<{ id: number }[]>`
      SELECT id FROM candidate_sync_changes WHERE candidate_master_id = ${blankRowResult.row.id}
    `;
    const blankModifyOutcome = await updateCandidateManualRow(
      blankRowResult.row.id,
      validatedBlankModify.values,
      validatedBlankModify.uncleanContactNumberRaw,
      blankClientOriginal,
      "verify-script@example.com",
      sql
    );
    check(
      results,
      "Modify: client-shaped blank original (unchanged) + one real change -> status 'ok', not 'stale'",
      blankModifyOutcome.status === "ok",
      blankModifyOutcome.status
    );
    if (blankModifyOutcome.status === "ok") {
      check(
        results,
        "Modify: changedFields is exactly ['status'] (blank fields did not register as changed)",
        blankModifyOutcome.result.changedFields.length === 1 &&
          blankModifyOutcome.result.changedFields[0] === "status"
      );
    }
    check(
      results,
      "Modify: the row's 5 new Accenture columns are at their default (client-shaped as '', stored as '-') in the stale-check snapshot, and that alone does not cause a false 'stale' (migration 022)",
      blankClientOriginal.accenture_candidate_stage === "" &&
        blankClientOriginal.current_cid_source === "" &&
        blankClientOriginal.application_completion_status === "" &&
        blankClientOriginal.screening_candidate_stage === "" &&
        blankClientOriginal.disposition_reason === "" &&
        blankModifyOutcome.status === "ok",
      `blankClientOriginal Accenture fields: ${JSON.stringify({
        accenture_candidate_stage: blankClientOriginal.accenture_candidate_stage,
        current_cid_source: blankClientOriginal.current_cid_source,
        application_completion_status: blankClientOriginal.application_completion_status,
        screening_candidate_stage: blankClientOriginal.screening_candidate_stage,
        disposition_reason: blankClientOriginal.disposition_reason,
      })}, outcome: ${blankModifyOutcome.status}`
    );
    const changeRowsAfterBlankModify = await sql<{ id: number }[]>`
      SELECT id FROM candidate_sync_changes WHERE candidate_master_id = ${blankRowResult.row.id}
    `;
    check(
      results,
      "Modify: exactly ONE new change row written for the blank-normalization modify",
      changeRowsAfterBlankModify.length === changeRowsBeforeBlankModify.length + 1
    );
    const afterBlankModifyRow = await getCandidateMasterById(blankRowResult.row.id, sql);
    check(
      results,
      "Modify: untouched blank fields stay '-' after the update (not overwritten with '')",
      afterBlankModifyRow?.status === "New Status" &&
        afterBlankModifyRow?.email === "-" &&
        afterBlankModifyRow?.contact_number === "-" &&
        afterBlankModifyRow?.submitter === "-" &&
        afterBlankModifyRow?.customer === "-" &&
        afterBlankModifyRow?.job_requisition_id === "-" &&
        afterBlankModifyRow?.primary_skills === "-" &&
        afterBlankModifyRow?.job_management_level === "-" &&
        afterBlankModifyRow?.market === "-" &&
        afterBlankModifyRow?.client_spoc === "-" &&
        afterBlankModifyRow?.submitted_date === "-" &&
        afterBlankModifyRow?.submission_comments === "-" &&
        afterBlankModifyRow?.gender === "-"
    );
    if (!afterBlankModifyRow) throw new Error("afterBlankModifyRow vanished");

    // (ii) Re-submitting the SAME client-shaped snapshot (post-update, no
    // real edit) -> 400 'no_change', and writes no new change row.
    const blankClientOriginal2 = clientShapedSnapshot(afterBlankModifyRow);
    const validatedNoop = validateCandidateManualInput(blankClientOriginal2);
    if (!validatedNoop.ok) throw new Error(`unexpected validation failure: ${validatedNoop.error}`);
    const changeRowsBeforeNoop = await sql<{ id: number }[]>`
      SELECT id FROM candidate_sync_changes WHERE candidate_master_id = ${blankRowResult.row.id}
    `;
    const blankNoopOutcome = await updateCandidateManualRow(
      blankRowResult.row.id,
      validatedNoop.values,
      validatedNoop.uncleanContactNumberRaw,
      blankClientOriginal2,
      "verify-script@example.com",
      sql
    );
    check(
      results,
      "Modify: client-shaped blank original, no real change -> status 'no_change' (route returns 400)",
      blankNoopOutcome.status === "no_change",
      blankNoopOutcome.status
    );
    const changeRowsAfterNoop = await sql<{ id: number }[]>`
      SELECT id FROM candidate_sync_changes WHERE candidate_master_id = ${blankRowResult.row.id}
    `;
    check(
      results,
      "Modify: no-change attempt writes no new change rows",
      changeRowsAfterNoop.length === changeRowsBeforeNoop.length
    );

    // (iii) A GENUINE concurrent change must still 409 — the fix must not
    // swallow real staleness. Use the stale (pre-update) client snapshot as
    // `original` against the row's actual current (post-update) state.
    const staleBlankForm = { ...blankClientOriginal, status: "Should Not Apply Either" };
    const validatedStaleBlank = validateCandidateManualInput(staleBlankForm);
    if (!validatedStaleBlank.ok) throw new Error(`unexpected validation failure: ${validatedStaleBlank.error}`);
    const genuineStaleOutcome = await updateCandidateManualRow(
      blankRowResult.row.id,
      validatedStaleBlank.values,
      validatedStaleBlank.uncleanContactNumberRaw,
      blankClientOriginal, // stale: real current status is now "New Status", not "Old Status"
      "verify-script@example.com",
      sql
    );
    check(
      results,
      "Modify: a genuine concurrent change is still caught as 'stale' (fix doesn't mask real conflicts)",
      genuineStaleOutcome.status === "stale",
      genuineStaleOutcome.status
    );

    // ===== 6. No-op modify =====
    const currentForNoop = await getCandidateMasterById(addResult.row.id, sql);
    if (!currentForNoop) throw new Error("currentForNoop row vanished");
    const currentSnapshot = {
      cid: currentForNoop.cid,
      date_of_upload: currentForNoop.date_of_upload,
      name: currentForNoop.name,
      email: currentForNoop.email,
      contact_number: currentForNoop.contact_number,
      submitter: currentForNoop.submitter,
      customer: currentForNoop.customer,
      job_requisition_id: currentForNoop.job_requisition_id,
      primary_skills: currentForNoop.primary_skills,
      job_management_level: currentForNoop.job_management_level,
      market: currentForNoop.market,
      client_spoc: currentForNoop.client_spoc,
      status: currentForNoop.status,
      accenture_candidate_stage: currentForNoop.accenture_candidate_stage,
      current_cid_source: currentForNoop.current_cid_source,
      application_completion_status: currentForNoop.application_completion_status,
      screening_candidate_stage: currentForNoop.screening_candidate_stage,
      disposition_reason: currentForNoop.disposition_reason,
      submitted_date: currentForNoop.submitted_date,
      submission_comments: currentForNoop.submission_comments,
      gender: currentForNoop.gender,
    } as CandidateManualFieldValues;
    const noopOutcome = await updateCandidateManualRow(
      addResult.row.id,
      currentSnapshot,
      null,
      currentSnapshot,
      "verify-script@example.com",
      sql
    );
    check(results, "Modify: identical values -> status 'no_change'", noopOutcome.status === "no_change");

    // ===== 7. Soft delete: hides from every read path, clears duplicate highlight on survivor =====
    const deleteResult = await softDeleteCandidateManualRow(addDuplicateResult.row.id, "verify-script@example.com", sql);
    check(results, "Delete: returns the deleted row's cid/name", deleteResult?.cid === testCids[0]);

    const afterDeleteRow = await getCandidateMasterById(addDuplicateResult.row.id, sql);
    check(results, "Delete: getCandidateMasterById no longer returns the soft-deleted row", afterDeleteRow === null);

    const afterDeleteList = await listCandidateMasterRows(sql);
    check(
      results,
      "Delete: listCandidateMasterRows excludes the soft-deleted row",
      !afterDeleteList.some((r) => r.id === addDuplicateResult.row.id)
    );

    const pageAfterDelete = await queryCandidateMasterSheetPage(
      { page: 1, pageSize: 500, columnFilters: {}, textFilters: {}, dateFilters: {}, highlightFilters: [], syncFilter: null },
      sql
    );
    check(
      results,
      "Delete: live duplicate_cid highlight clears on the survivor once the duplicate is soft-deleted",
      !(pageAfterDelete.highlights.duplicateFlagCids[testCids[0]] ?? []).includes("duplicate_cid")
    );

    const deletedRowRaw = await sql<{ deleted_at: string | null; deleted_by: string | null }[]>`
      SELECT deleted_at, deleted_by FROM candidate_master WHERE id = ${addDuplicateResult.row.id}
    `;
    check(
      results,
      "Delete: row still physically present with deleted_at/deleted_by set (soft, not hard)",
      deletedRowRaw[0]?.deleted_at != null && deletedRowRaw[0]?.deleted_by === "verify-script@example.com"
    );

    // ===== 8. Oorwin dup-CID fix: CID+JR disambiguation, then quarantine when still ambiguous =====
    await sql`
      INSERT INTO candidate_master (
        cid, name, gender, contact_number, date_of_upload, submitter, customer,
        job_requisition_id, primary_skills, job_management_level, market,
        client_spoc, status, submitted_date, submission_comments, email
      ) VALUES
        (${testCids[1]}, 'JR-A Row', '-', '-', '01/01/2026', '-', '-', ${JR("A")}, '-', '-', '-', '-', 'Old', '-', '-', '-'),
        (${testCids[1]}, 'JR-B Row', '-', '-', '01/01/2026', '-', '-', ${JR("B")}, '-', '-', '-', '-', 'Old', '-', '-', '-')
    `;
    const [{ id: historyIdForSync1 }] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, result, source_filename, triggered_by, kind)
      VALUES (NOW(), 'success', 'verify-manual-edit-test', 'verify-script', 'oorwin_upload')
      RETURNING id
    `;
    const syncSummary1 = await runCandidateSync(
      [
        sheetRow({
          cid: testCids[1],
          clientSubmissionJr: JR("A"),
          status: "Updated Via Sync",
          sheetRowNumber: 1,
        }),
      ],
      historyIdForSync1,
      sql
    );
    check(
      results,
      "Oorwin dup-CID fix: CID+JR narrows to exactly one row and updates it (no throw)",
      syncSummary1.updatedCount === 1 && syncSummary1.quarantinedCount === 0
    );
    const jrARowAfterSync = await sql<{ status: string }[]>`
      SELECT status FROM candidate_master WHERE cid = ${testCids[1]} AND job_requisition_id = ${JR("A")}
    `;
    const jrBRowAfterSync = await sql<{ status: string }[]>`
      SELECT status FROM candidate_master WHERE cid = ${testCids[1]} AND job_requisition_id = ${JR("B")}
    `;
    check(
      results,
      "Oorwin dup-CID fix: only the JR-A row was updated, JR-B row untouched",
      jrARowAfterSync[0]?.status === "Updated Via Sync" && jrBRowAfterSync[0]?.status === "Old"
    );

    const syncSummary2 = await runCandidateSync(
      [
        sheetRow({
          cid: testCids[1],
          clientSubmissionJr: JR("NOT-FOUND"), // matches neither JR-A nor JR-B live row -> still ambiguous
          sheetRowNumber: 2,
        }),
      ],
      historyIdForSync1,
      sql
    );
    check(
      results,
      "Oorwin dup-CID fix: still ambiguous after JR narrowing -> quarantined, not thrown, rest of sheet unaffected",
      syncSummary2.quarantinedCount === 1 && syncSummary2.updatedCount === 0 && syncSummary2.insertedCount === 0
    );
    const quarantineFlag = await sql<{ reason: string }[]>`
      SELECT reason FROM candidate_review_flags WHERE sync_id = ${historyIdForSync1} AND cid = ${testCids[1]} AND reason = 'duplicate_cid'
    `;
    check(results, "Oorwin dup-CID fix: duplicate_cid review flag written for the ambiguous row", quarantineFlag.length >= 1);

    // ===== 9. Soft-deleted-only CID gets re-inserted by Oorwin (not silently skipped) =====
    const deletedOnlyAdd = await insertCandidateManualRow(
      {
        cid: testCids[2],
        name: "To Be Deleted Then Re-Synced",
        email: "-",
        contact_number: "-",
        date_of_upload: "01/01/2026",
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
      },
      null,
      "verify-script@example.com"
    );
    await softDeleteCandidateManualRow(deletedOnlyAdd.row.id, "verify-script@example.com", sql);
    const [{ id: historyIdForSync2 }] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, result, source_filename, triggered_by, kind)
      VALUES (NOW(), 'success', 'verify-manual-edit-test', 'verify-script', 'oorwin_upload')
      RETURNING id
    `;
    const syncSummary3 = await runCandidateSync(
      [sheetRow({ cid: testCids[2], sheetRowNumber: 1 })],
      historyIdForSync2,
      sql
    );
    check(
      results,
      "Soft-deleted-only CID: Oorwin re-inserts as a fresh row rather than silently skipping",
      syncSummary3.insertedCount === 1
    );
    const liveRowsForReinsertedCid = await getCandidateMasterRowsByCid(testCids[2], sql);
    check(results, "Soft-deleted-only CID: exactly one LIVE row exists after re-insert", liveRowsForReinsertedCid.length === 1);

    // ===== 10. "Recently changed" window fix =====
    const [{ id: staleUploadId }] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, result, source_filename, triggered_by, kind)
      VALUES (NOW() - INTERVAL '10 days', 'success', 'verify-stale-upload', 'someone@example.com', 'oorwin_upload')
      RETURNING id
    `;
    await sql`
      INSERT INTO candidate_sync_changes (sync_id, cid, field_name, old_value, new_value, candidate_master_id)
      VALUES (${staleUploadId}, ${testCids[3]}, 'status', 'Old', 'New', NULL)
    `;
    const [{ id: latestUploadId }] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, result, source_filename, triggered_by, kind)
      VALUES (NOW(), 'success', 'verify-latest-upload', 'someone@example.com', 'oorwin_upload')
      RETURNING id
    `;
    await sql`
      INSERT INTO candidate_sync_changes (sync_id, cid, field_name, old_value, new_value, candidate_master_id)
      VALUES (${latestUploadId}, ${testCids[4]}, 'status', 'Old', 'New', NULL)
    `;
    const [{ id: laterManualId }] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, result, source_filename, triggered_by, kind)
      VALUES (NOW(), 'success', 'manual-modify', 'verify-script@example.com', 'manual_modify')
      RETURNING id
    `;
    await sql`
      INSERT INTO candidate_sync_changes (sync_id, cid, field_name, old_value, new_value, candidate_master_id)
      VALUES (${laterManualId}, ${testCids[5]}, 'status', 'Old', 'New', NULL)
    `;
    const windowIds = await getCandidateRecentChangeWindowSyncIds(sql);
    // candidate_sync_history.id is BIGSERIAL; postgres.js returns bigint
    // columns as strings by default (same gotcha noted in candidate-sync-job.ts),
    // so the destructured ids above are runtime strings despite the `number`
    // type annotation — cast before comparing against windowIds (real numbers).
    check(
      results,
      "Recently changed window: includes the LATEST upload + the manual sync after it, excludes the stale older upload",
      windowIds.includes(Number(latestUploadId)) &&
        windowIds.includes(Number(laterManualId)) &&
        !windowIds.includes(Number(staleUploadId))
    );
    const changedFieldsInWindow = await getLatestCandidateChangedFields(windowIds, sql);
    check(
      results,
      "Recently changed window: changed-fields map includes the latest-upload CID and the manual CID, not the stale one",
      changedFieldsInWindow.has(testCids[4]) &&
        changedFieldsInWindow.has(testCids[5]) &&
        !changedFieldsInWindow.has(testCids[3])
    );

    // ===== 11. JR Scan / auto-fetch `sources` field (additive) =====
    const scanLateralOnly = await resolveCandidateAutoFetchFields(JR("LATERAL-ONLY"), { primarySkills: null, market: null, clientSpoc: null }, sql);
    check(results, "Scan: lateral-only -> sources.lateral=true, executive=false", scanLateralOnly.sources.lateral && !scanLateralOnly.sources.executive);

    const scanBothAgree = await resolveCandidateAutoFetchFields(JR("BOTH-AGREE"), { primarySkills: null, market: null, clientSpoc: null }, sql);
    check(
      results,
      "Scan: both agree -> sources both true, no conflicts, values usable",
      scanBothAgree.sources.lateral && scanBothAgree.sources.executive && scanBothAgree.conflicts.length === 0 && scanBothAgree.values.primarySkills === "Shared Skill"
    );

    const scanConflict = await resolveCandidateAutoFetchFields(JR("BOTH-CONFLICT"), { primarySkills: null, market: null, clientSpoc: null }, sql);
    check(
      results,
      "Scan: both found but disagree -> sources both true, conflicts recorded, values null (never silently prefer either)",
      scanConflict.sources.lateral && scanConflict.sources.executive && scanConflict.conflicts.length > 0 && scanConflict.values.primarySkills === null
    );

    const scanNotFound = await resolveCandidateAutoFetchFields(JR("NOT-FOUND"), { primarySkills: null, market: null, clientSpoc: null }, sql);
    check(
      results,
      "Scan: not found in either table -> sources both false, values fall back to null (no Oorwin fallback supplied)",
      !scanNotFound.sources.lateral && !scanNotFound.sources.executive && scanNotFound.values.primarySkills === null
    );

    // ===== 12. Purge: dry-run visibility + retention-window correctness =====
    const purgeOldRow = await insertCandidateManualRow(
      {
        cid: testCids[6],
        name: "Purge Eligible",
        email: "-",
        contact_number: "-",
        date_of_upload: "01/01/2026",
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
      },
      null,
      "verify-script@example.com"
    );
    await softDeleteCandidateManualRow(purgeOldRow.row.id, "verify-script@example.com", sql);
    // Backdate deleted_at past the 30-day retention window.
    await sql`UPDATE candidate_master SET deleted_at = NOW() - INTERVAL '31 days' WHERE id = ${purgeOldRow.row.id}`;

    // beforeModify's row (testCids[0], addResult) is still live (never deleted) — stays as a control.
    const purgeResult = await runCandidatePurge();
    check(
      results,
      "Purge: run does not report busy (lock acquired) and returns a purged-row list",
      purgeResult.busy === false
    );
    check(
      results,
      "Purge: the >30-day-old soft-deleted row was permanently deleted",
      purgeResult.purgedRows.some((r) => r.id === purgeOldRow.row.id)
    );
    const purgedRowGone = await sql<{ id: number }[]>`SELECT id FROM candidate_master WHERE id = ${purgeOldRow.row.id}`;
    check(results, "Purge: row no longer exists in candidate_master at all (hard delete)", purgedRowGone.length === 0);

    // ===== 13. validateCandidateManualInput: basic rejection paths =====
    const missingCid = validateCandidateManualInput(fullValues({ cid: "", name: "Someone" }));
    check(results, "Validation: blank CID rejected", missingCid.ok === false);
    const badCidFormat = validateCandidateManualInput(fullValues({ cid: "not-a-cid", name: "Someone" }));
    check(results, "Validation: malformed CID rejected", badCidFormat.ok === false);
    const missingName = validateCandidateManualInput(fullValues({ cid: testCids[6], name: "" }));
    check(results, "Validation: blank name rejected", missingName.ok === false);
    const badDate = validateCandidateManualInput(
      fullValues({ cid: testCids[6], name: "Someone", submitted_date: "2026-01-01" })
    );
    check(results, "Validation: non-DD/MM/YYYY date rejected", badDate.ok === false);
  } finally {
    // ---- Cleanup: everything this run created, success or failure ----
    await sql`DELETE FROM candidate_review_flags WHERE cid = ANY(${testCids})`;
    await sql`DELETE FROM candidate_sync_changes WHERE cid = ANY(${testCids})`;
    await sql`DELETE FROM candidate_master WHERE cid = ANY(${testCids})`;
    await sql`DELETE FROM candidate_sync_history WHERE source_filename IN ('manual-add', 'manual-modify', 'verify-manual-edit-test', 'verify-stale-upload', 'verify-latest-upload') AND triggered_by IN ('verify-script@example.com', 'verify-script', 'someone@example.com')`;
    await sql`DELETE FROM lateral_master WHERE job_requisition_id = ANY(${testJrs})`;
    await sql`DELETE FROM executive_master WHERE job_requisition_id = ANY(${testJrs})`;
    await closeDbClient();
  }

  const failures = results.filter((r) => r.status === "FAIL");
  console.log(`\n${"=".repeat(70)}`);
  for (const r of results) {
    console.log(`${r.status === "PASS" ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  }
  console.log("=".repeat(70));
  console.log(`${results.length - failures.length}/${results.length} passed`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
