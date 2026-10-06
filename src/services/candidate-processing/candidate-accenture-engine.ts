/**
 * Core compare/update engine for the Candidate Master Sheet Accenture Final
 * Report upload (migration 022, Stage 2).
 *
 * Unlike the Oorwin sync engine (candidate-sync-engine.ts), which commits
 * each row independently, this engine is always run inside ONE transaction
 * for the whole file (the caller — candidate-accenture-sync-job.ts — opens
 * it) so a mid-file failure can roll back everything cleanly. `dryRun: true`
 * runs the exact same read/diff logic but structurally never calls a write
 * statement (INSERT/UPDATE/writeChange/writeReviewFlag) — see the `dryRun`
 * branches below — so "zero writes" holds even if a future edit here has a
 * bug, not just because every call site remembered to check a flag.
 *
 * Per-CID processing (file order):
 *  - Blank CID: skipped, counted (`skippedBlankCidCount`).
 *  - Malformed CID (not /^C[0-9]+$/, migration 018's format): skipped,
 *    flagged via the EXISTING `invalid_candidate_id` review-flag reason
 *    (candidate-sync-engine.ts) — no new reason/migration needed.
 *  - No live row shares this CID: INSERT one new row from this CID's FIRST
 *    file occurrence only. If the group has more than one occurrence, every
 *    remaining one is then fed through the exact same matched-row chain
 *    (below) the just-inserted row would get on a later, separate upload —
 *    so a brand-new CID repeated in one file ends up at the same final
 *    values a single occurrence would have produced on its own eventual
 *    last state, but with one logged `candidate_sync_changes` step per real
 *    change instead of silently collapsing to the last occurrence with no
 *    history. `name` IS written literally from the first occurrence here
 *    (there is no prior name to protect yet) — but once the row exists, the
 *    continuation treats it exactly like any matched row's name: never
 *    overwritten, only noted on a mismatch.
 *  - One or more live rows share this CID: apply to EVERY one of them, no
 *    narrowing (unlike the Oorwin engine's CID+JR narrowing for ambiguous
 *    CIDs) — the spec for this feature is explicit that an Accenture
 *    upload touches every row sharing a CID.
 *
 * For each of the 5 synced fields (email, job_management_level,
 * accenture_candidate_stage, current_cid_source, application_completion_status)
 * on a matched row, `computeAccentureFieldChain` walks the stored value and
 * this CID's file occurrences (in file order, consecutive duplicates
 * collapsed) and either writes nothing (final value === stored value — the
 * re-upload/idempotency case) or writes the final value once and logs one
 * `candidate_sync_changes` row per real step. Email/level occurrences are
 * pre-filtered to "usable" ones only (non-blank, and for level, parseable)
 * before entering the chain — a blank/unparseable cell never overwrites a
 * stored value and never sets that field's Accenture lock; the 3 snapshot
 * fields have no such filtering (a blank file cell is a real occurrence of
 * "-", per the plain-diff rule). The brand-new-CID continuation above reuses
 * this unchanged — the just-inserted row's first-occurrence values are its
 * "stored" starting point.
 *
 * `name` is never written to the `name` column on a MATCHED row (see
 * `buildRowPlan` / `applyMatchedRowWrites`) — only a dedup-checked
 * `candidate_sync_changes` note. (A brand-new row's insert is the one
 * exception — see above.)
 */
import {
  getCandidateMasterRowsByCid,
  type CandidateMasterRow,
  type SqlClient,
} from "@/services/persistence/read-candidate-master";
import {
  coerceBlank,
  isValidCidFormat,
  todayAsDdMmYyyy,
  writeChange,
  writeReviewFlag,
} from "./candidate-sync-engine";
import { extractJmlNumber, formatJmlAsLegacy } from "./candidate-jml-format";
import type { CandidateAccentureParsedRow } from "./candidate-accenture-parser";

function isBlankCid(cid: string): boolean {
  const t = cid.trim();
  return t === "" || t === "-";
}

function normalizeNameForMatch(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface CandidateAccentureChainStep {
  oldValue: string;
  newValue: string;
}

export interface CandidateAccentureChainResult {
  steps: CandidateAccentureChainStep[];
  finalValue: string;
  wouldWrite: boolean;
}

/**
 * Walks [stored, ...occurrences], logging one step per adjacent pair that
 * actually differs (back-to-back repeats are not steps), BUT short-circuits
 * to "nothing happens" whenever the final occurrence equals the stored
 * value — even if the walk passed through a different value in between
 * (e.g. stored "C", file [A, C] -> 0 steps). This is what makes a
 * byte-identical re-upload a true no-op: the raw re-upload sequence has no
 * adjacent duplicates, so the only thing that can catch it is this
 * final-equals-stored check, not a dedupe of the raw sequence.
 */
export function computeAccentureFieldChain(
  stored: string,
  occurrences: string[]
): CandidateAccentureChainResult {
  const finalValue = occurrences.length > 0 ? occurrences[occurrences.length - 1] : stored;
  if (finalValue === stored) {
    return { steps: [], finalValue, wouldWrite: false };
  }
  const seq = [stored, ...occurrences];
  const steps: CandidateAccentureChainStep[] = [];
  for (let i = 1; i < seq.length; i += 1) {
    if (seq[i] !== seq[i - 1]) {
      steps.push({ oldValue: seq[i - 1], newValue: seq[i] });
    }
  }
  return { steps, finalValue, wouldWrite: true };
}

interface AccentureFileGroups {
  groups: Map<string, CandidateAccentureParsedRow[]>;
  groupOrder: string[];
  skippedBlankCidCount: number;
  invalidCidRows: CandidateAccentureParsedRow[];
}

/** Step 1: group file rows by CID (file order preserved), separating blank/malformed CIDs. Pure — no DB access. */
export function planAccentureFileGroups(rows: CandidateAccentureParsedRow[]): AccentureFileGroups {
  const groups = new Map<string, CandidateAccentureParsedRow[]>();
  const groupOrder: string[] = [];
  const invalidCidRows: CandidateAccentureParsedRow[] = [];
  let skippedBlankCidCount = 0;

  for (const row of rows) {
    const trimmed = row.cid.trim();
    if (isBlankCid(trimmed)) {
      skippedBlankCidCount += 1;
      continue;
    }
    if (!isValidCidFormat(trimmed)) {
      invalidCidRows.push(row);
      continue;
    }
    if (!groups.has(trimmed)) {
      groups.set(trimmed, []);
      groupOrder.push(trimmed);
    }
    groups.get(trimmed)!.push(row);
  }

  return { groups, groupOrder, skippedBlankCidCount, invalidCidRows };
}

function usableEmailOccurrences(rows: CandidateAccentureParsedRow[]): string[] {
  return rows.map((r) => r.email.trim()).filter((v) => v !== "" && v !== "-");
}

function usableLevelOccurrences(rows: CandidateAccentureParsedRow[]): string[] {
  const result: string[] = [];
  for (const r of rows) {
    const n = extractJmlNumber(r.level);
    if (n !== null) result.push(formatJmlAsLegacy(n));
  }
  return result;
}

function normalizeStoredLevel(stored: string): string {
  const n = extractJmlNumber(stored);
  return n !== null ? formatJmlAsLegacy(n) : stored;
}

function snapshotOccurrences(
  rows: CandidateAccentureParsedRow[],
  pick: (row: CandidateAccentureParsedRow) => string
): string[] {
  return rows.map((r) => coerceBlank(pick(r)));
}

export interface CandidateAccentureRowPlan {
  email: CandidateAccentureChainResult;
  emailUsableThisRun: boolean;
  level: CandidateAccentureChainResult;
  levelUsableThisRun: boolean;
  stage: CandidateAccentureChainResult;
  cidSource: CandidateAccentureChainResult;
  completionStatus: CandidateAccentureChainResult;
  anyFieldChanged: boolean;
  lastFileName: string;
  nameMismatchCandidate: boolean;
}

/** Pure — computes what WOULD happen to one live row against this CID's file occurrences. No DB access. */
export function buildAccentureRowPlan(
  existing: CandidateMasterRow,
  groupRows: CandidateAccentureParsedRow[]
): CandidateAccentureRowPlan {
  const emailOcc = usableEmailOccurrences(groupRows);
  const email = computeAccentureFieldChain(existing.email, emailOcc);

  const levelOcc = usableLevelOccurrences(groupRows);
  const level = computeAccentureFieldChain(normalizeStoredLevel(existing.job_management_level), levelOcc);

  const stage = computeAccentureFieldChain(
    existing.accenture_candidate_stage,
    snapshotOccurrences(groupRows, (r) => r.candidateStage)
  );
  const cidSource = computeAccentureFieldChain(
    existing.current_cid_source,
    snapshotOccurrences(groupRows, (r) => r.currentCidSource)
  );
  const completionStatus = computeAccentureFieldChain(
    existing.application_completion_status,
    snapshotOccurrences(groupRows, (r) => r.applicationCompletionStatus)
  );

  const anyFieldChanged = [email, level, stage, cidSource, completionStatus].some((c) => c.wouldWrite);

  const lastFileName = groupRows[groupRows.length - 1]?.name.trim() ?? "";
  const nameMismatchCandidate =
    lastFileName !== "" && normalizeNameForMatch(lastFileName) !== normalizeNameForMatch(existing.name);

  return {
    email,
    emailUsableThisRun: emailOcc.length > 0,
    level,
    levelUsableThisRun: levelOcc.length > 0,
    stage,
    cidSource,
    completionStatus,
    anyFieldChanged,
    lastFileName,
    nameMismatchCandidate,
  };
}

/** Writes a matched row's plan: step-chain history rows, the name-mismatch note (deduped), and the row UPDATE. */
async function applyMatchedRowWrites(
  sqlClient: SqlClient,
  syncId: number,
  existing: CandidateMasterRow,
  plan: CandidateAccentureRowPlan
): Promise<{ nameMismatchWritten: boolean }> {
  const fieldChains: [string, CandidateAccentureChainResult][] = [
    ["email", plan.email],
    ["job_management_level", plan.level],
    ["accenture_candidate_stage", plan.stage],
    ["current_cid_source", plan.cidSource],
    ["application_completion_status", plan.completionStatus],
  ];
  for (const [field, chain] of fieldChains) {
    if (!chain.wouldWrite) continue;
    for (const step of chain.steps) {
      await writeChange(sqlClient, syncId, existing.cid, field, step.oldValue, step.newValue, existing.id);
    }
  }

  let nameMismatchWritten = false;
  if (plan.nameMismatchCandidate) {
    const latestNoteRows = await sqlClient<{ new_value: string | null }[]>`
      SELECT new_value FROM candidate_sync_changes
      WHERE candidate_master_id = ${existing.id} AND field_name = 'name'
      ORDER BY id DESC LIMIT 1
    `;
    const latestNote = latestNoteRows[0];
    if (!latestNote || latestNote.new_value !== plan.lastFileName) {
      await writeChange(sqlClient, syncId, existing.cid, "name", existing.name, plan.lastFileName, existing.id);
      nameMismatchWritten = true;
    }
  }

  const finalEmail = plan.email.wouldWrite ? plan.email.finalValue : existing.email;
  const finalLevel = plan.level.wouldWrite ? plan.level.finalValue : existing.job_management_level;
  const finalStage = plan.stage.wouldWrite ? plan.stage.finalValue : existing.accenture_candidate_stage;
  const finalCidSource = plan.cidSource.wouldWrite ? plan.cidSource.finalValue : existing.current_cid_source;
  const finalCompletion = plan.completionStatus.wouldWrite
    ? plan.completionStatus.finalValue
    : existing.application_completion_status;
  const newEmailLocked = existing.email_accenture_locked || plan.emailUsableThisRun;
  const newLevelLocked = existing.job_management_level_accenture_locked || plan.levelUsableThisRun;

  if (plan.anyFieldChanged) {
    await sqlClient`
      UPDATE candidate_master SET
        email = ${finalEmail},
        job_management_level = ${finalLevel},
        accenture_candidate_stage = ${finalStage},
        current_cid_source = ${finalCidSource},
        application_completion_status = ${finalCompletion},
        email_accenture_locked = ${newEmailLocked},
        job_management_level_accenture_locked = ${newLevelLocked},
        last_accenture_sync_id = ${syncId},
        last_touched_at = NOW()
      WHERE id = ${existing.id}
    `;
  } else {
    // last_accenture_sync_id advances on EVERY matched row, every run, even
    // when nothing else changed — but that alone must not bump
    // last_touched_at, so this branch omits it from the SET list entirely
    // rather than re-writing its existing value (two static queries instead
    // of one dynamic SET list, matching this codebase's existing convention
    // of avoiding dynamic SQL composition).
    await sqlClient`
      UPDATE candidate_master SET
        email_accenture_locked = ${newEmailLocked},
        job_management_level_accenture_locked = ${newLevelLocked},
        last_accenture_sync_id = ${syncId}
      WHERE id = ${existing.id}
    `;
  }

  return { nameMismatchWritten };
}

async function applyInsertRow(
  sqlClient: SqlClient,
  syncId: number,
  cid: string,
  groupRows: CandidateAccentureParsedRow[]
): Promise<{ emailUsable: boolean; levelUsable: boolean }> {
  // Insert from the FIRST occurrence only — any later occurrences in this
  // CID's group are fed through the same matched-row chain machinery right
  // after (see the `existingRows.length === 0` branch below), exactly like
  // a CID that already existed before this run. Lock flags below still
  // consider every occurrence in the group, not just the first — the lock
  // rule itself (locked if ANY occurrence this run supplied a usable value)
  // is unaffected by this change.
  const firstRow = groupRows[0];
  const name = coerceBlank(firstRow.name);
  const emailOcc = usableEmailOccurrences(groupRows);
  const email = emailOcc.length > 0 ? emailOcc[0] : "-";
  const levelOcc = usableLevelOccurrences(groupRows);
  const level = levelOcc.length > 0 ? levelOcc[0] : "-";
  const stage = coerceBlank(firstRow.candidateStage);
  const cidSource = coerceBlank(firstRow.currentCidSource);
  const completionStatus = coerceBlank(firstRow.applicationCompletionStatus);
  const today = todayAsDdMmYyyy();
  const emailUsable = emailOcc.length > 0;
  const levelUsable = levelOcc.length > 0;

  await sqlClient`
    INSERT INTO candidate_master (
      cid, name, gender, contact_number, date_of_upload, submitter, customer,
      job_requisition_id, primary_skills, job_management_level, market,
      client_spoc, status, accenture_candidate_stage, current_cid_source,
      application_completion_status, screening_candidate_stage, disposition_reason,
      submitted_date, submission_comments, email,
      email_accenture_locked, job_management_level_accenture_locked,
      last_touched_at, inserted_sync_id, last_accenture_sync_id
    ) VALUES (
      ${cid}, ${name}, '-', '-', ${today}, '-', '-',
      '-', '-', ${level}, '-',
      '-', '-', ${stage}, ${cidSource},
      ${completionStatus}, '-', '-',
      '-', '-', ${email},
      ${emailUsable}, ${levelUsable},
      NOW(), ${syncId}, ${syncId}
    )
  `;
  return { emailUsable, levelUsable };
}

export interface CandidateAccentureSyncSummary {
  rowsInSheet: number;
  matchedCidCount: number;
  matchedRowCount: number;
  insertedCount: number;
  skippedBlankCidCount: number;
  invalidCidCount: number;
  reviewFlagCount: number;
  fieldChangeCounts: {
    email: number;
    job_management_level: number;
    accenture_candidate_stage: number;
    current_cid_source: number;
    application_completion_status: number;
  };
  /** Level occurrence was usable but reduced to the same number as the stored value — no write, by design. */
  levelFormatOnlyNoOpCount: number;
  nameMismatchNotesCount: number;
  /** Blank file cells in the 3 snapshot columns (Stage/CID Source/Application Completion Status) stored as "-". */
  blankCellsKeptCount: number;
  /** Rows whose lock flipped false -> true this run (already-true rows are not counted again). */
  newlyLockedCount: { email: number; job_management_level: number };
}

/**
 * Runs the whole-file compare/update. `dryRun: true` performs every read
 * and every diff computation but never calls a write statement — see the
 * `if (!dryRun)` / `else` branches below, not a flag threaded into the
 * write helpers themselves.
 */
export async function runCandidateAccentureSync(
  parsedRows: CandidateAccentureParsedRow[],
  syncId: number | null,
  sqlClient: SqlClient,
  options: { dryRun?: boolean } = {}
): Promise<CandidateAccentureSyncSummary> {
  const dryRun = options.dryRun ?? false;
  const plan = planAccentureFileGroups(parsedRows);

  let reviewFlagCount = 0;
  if (!dryRun) {
    for (const row of plan.invalidCidRows) {
      await writeReviewFlag(sqlClient, syncId as number, row.cid.trim(), "invalid_candidate_id", {
        sheetRowNumber: row.sheetRowNumber,
        rawCid: row.cid,
        source: "accenture_upload",
      });
      reviewFlagCount += 1;
    }
  } else {
    reviewFlagCount = plan.invalidCidRows.length;
  }

  let matchedCidCount = 0;
  let matchedRowCount = 0;
  let insertedCount = 0;
  let nameMismatchNotesCount = 0;
  let levelFormatOnlyNoOpCount = 0;
  let blankCellsKeptCount = 0;
  const fieldChangeCounts = {
    email: 0,
    job_management_level: 0,
    accenture_candidate_stage: 0,
    current_cid_source: 0,
    application_completion_status: 0,
  };
  const newlyLockedCount = { email: 0, job_management_level: 0 };

  for (const cid of plan.groupOrder) {
    const groupRows = plan.groups.get(cid)!;
    const lastRow = groupRows[groupRows.length - 1];
    for (const raw of [
      lastRow.candidateStage,
      lastRow.currentCidSource,
      lastRow.applicationCompletionStatus,
    ]) {
      if (raw.trim() === "" || raw.trim() === "-") blankCellsKeptCount += 1;
    }

    const existingRows = await getCandidateMasterRowsByCid(cid, sqlClient);

    if (existingRows.length === 0) {
      insertedCount += 1;
      const emailOcc = usableEmailOccurrences(groupRows);
      const levelOcc = usableLevelOccurrences(groupRows);
      if (emailOcc.length > 0) newlyLockedCount.email += 1;
      if (levelOcc.length > 0) newlyLockedCount.job_management_level += 1;
      if (!dryRun) {
        await applyInsertRow(sqlClient, syncId as number, cid, groupRows);
        // This CID's file group had MORE than one occurrence: the row was
        // just inserted from occurrence[0] alone, so every remaining
        // occurrence (1..n-1) is still unapplied. Re-read the row this
        // transaction just wrote and run it through the exact same
        // matched-row chain (buildAccentureRowPlan / applyMatchedRowWrites)
        // a pre-existing CID would use — so a brand-new CID repeated in one
        // file ends up with the SAME final values as before (the file's
        // last occurrence) but, unlike before, one logged
        // candidate_sync_changes step per real change instead of silently
        // collapsing straight to the last occurrence with no history.
        if (groupRows.length > 1) {
          const [insertedRow] = await getCandidateMasterRowsByCid(cid, sqlClient);
          if (insertedRow) {
            const continuationPlan = buildAccentureRowPlan(insertedRow, groupRows.slice(1));
            if (continuationPlan.email.wouldWrite) fieldChangeCounts.email += 1;
            if (continuationPlan.level.wouldWrite) fieldChangeCounts.job_management_level += 1;
            else if (continuationPlan.levelUsableThisRun) levelFormatOnlyNoOpCount += 1;
            if (continuationPlan.stage.wouldWrite) fieldChangeCounts.accenture_candidate_stage += 1;
            if (continuationPlan.cidSource.wouldWrite) fieldChangeCounts.current_cid_source += 1;
            if (continuationPlan.completionStatus.wouldWrite) {
              fieldChangeCounts.application_completion_status += 1;
            }
            const { nameMismatchWritten } = await applyMatchedRowWrites(
              sqlClient,
              syncId as number,
              insertedRow,
              continuationPlan
            );
            if (nameMismatchWritten) nameMismatchNotesCount += 1;
          }
        }
      }
      continue;
    }

    matchedCidCount += 1;
    matchedRowCount += existingRows.length;

    for (const existing of existingRows) {
      const rowPlan = buildAccentureRowPlan(existing, groupRows);

      if (rowPlan.email.wouldWrite) fieldChangeCounts.email += 1;
      if (rowPlan.level.wouldWrite) fieldChangeCounts.job_management_level += 1;
      else if (rowPlan.levelUsableThisRun) levelFormatOnlyNoOpCount += 1;
      if (rowPlan.stage.wouldWrite) fieldChangeCounts.accenture_candidate_stage += 1;
      if (rowPlan.cidSource.wouldWrite) fieldChangeCounts.current_cid_source += 1;
      if (rowPlan.completionStatus.wouldWrite) fieldChangeCounts.application_completion_status += 1;

      if (!existing.email_accenture_locked && rowPlan.emailUsableThisRun) newlyLockedCount.email += 1;
      if (!existing.job_management_level_accenture_locked && rowPlan.levelUsableThisRun) {
        newlyLockedCount.job_management_level += 1;
      }

      if (!dryRun) {
        const { nameMismatchWritten } = await applyMatchedRowWrites(
          sqlClient,
          syncId as number,
          existing,
          rowPlan
        );
        if (nameMismatchWritten) nameMismatchNotesCount += 1;
      } else if (rowPlan.nameMismatchCandidate) {
        const latestNoteRows = await sqlClient<{ new_value: string | null }[]>`
          SELECT new_value FROM candidate_sync_changes
          WHERE candidate_master_id = ${existing.id} AND field_name = 'name'
          ORDER BY id DESC LIMIT 1
        `;
        const latestNote = latestNoteRows[0];
        if (!latestNote || latestNote.new_value !== rowPlan.lastFileName) nameMismatchNotesCount += 1;
      }
    }
  }

  return {
    rowsInSheet: parsedRows.length,
    matchedCidCount,
    matchedRowCount,
    insertedCount,
    skippedBlankCidCount: plan.skippedBlankCidCount,
    invalidCidCount: plan.invalidCidRows.length,
    reviewFlagCount,
    fieldChangeCounts,
    levelFormatOnlyNoOpCount,
    nameMismatchNotesCount,
    blankCellsKeptCount,
    newlyLockedCount,
  };
}
