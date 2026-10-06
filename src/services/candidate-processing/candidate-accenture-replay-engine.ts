/**
 * Replay-mode compare/update engine for the Accenture Final Report "Master
 * Sheet" upload — a dated, multi-row-per-candidate export (51 report dates
 * per candidate, 2026-01-26 .. 2026-10-04 for the first load) that must be
 * replayed through the SAME field rules as the classic single-snapshot
 * engine (candidate-accenture-engine.ts), in file-date order, logging one
 * `candidate_sync_changes` row per real step — including reverts — while
 * writing only the final value to the live `candidate_master` column.
 *
 * Deliberately a separate module, not a mode flag threaded through the
 * classic engine: `computeAccentureFieldChain`'s skip-when-final-equals-
 * stored short-circuit is the documented idempotency mechanism for the
 * already-shipped single-snapshot path, and `snapshotOccurrences` there
 * treats a blank cell as a real `"-"` value — both wrong for this file (see
 * the module-level numbers in the plan this was built from: Candidate
 * Stage alone has only 2 blank-flips against 5,078 real changes, so a
 * blank report cell means "no information that day," never a step, never
 * an overwrite). `candidate-accenture-engine.ts` is untouched by this file.
 * `planAccentureFileGroups` (CID grouping, blank/invalid-CID skip) is the
 * one piece reused as-is — it's pure and identical in both modes.
 *
 * DISPATCH: candidate-accenture-sync-job.ts picks this engine over the
 * classic one based on `CandidateAccentureParseSuccess.hasDateColumn` —
 * this module is never invoked for a file without a "Date" column.
 *
 * SCALE: a single `writeChange` call per step (as the classic engine does)
 * would be ~18,500 sequential round trips for the first load. This engine
 * instead collects every step for the whole file into one in-memory array
 * and flushes it as a handful of batched multi-row INSERTs (chunked, see
 * `insertStepsBatched`) — the per-row `candidate_master` UPDATEs stay one
 * statement per row (at most ~3,300 for the first load), which is not
 * worth the complexity of a bulk UPDATE..FROM(VALUES) for this scale.
 *
 * LATEST-WRITER ORDERING (held item — read-candidate-accenture-highlights.ts
 * is NOT touched by this module or anywhere else in this change): every
 * row inserted here gets a HIGHER `id` than any pre-existing row purely
 * from being inserted today, regardless of its backdated `changed_at` — so
 * neither "latest by id" nor "latest by changed_at" alone is correct in
 * every case once some fields are backdated and others aren't. The fix
 * applied here is write-side: the ONE step (per CID, per field, per run)
 * that actually mutates the live `candidate_master` column — i.e.
 * `wouldWriteLive` — is stamped with this run's REAL time (`liveWriteAt`,
 * captured once at the top of the run), not its true historical file
 * date; every OTHER step (every earlier step in the same chain, and every
 * step for a field this run decided NOT to write live because it's frozen,
 * see below) keeps its true backdated noon-IST file date. This makes a
 * plain `ORDER BY changed_at DESC, id DESC` correct for "who actually
 * determined the live cell" in every case — the read-side fix a reviewer
 * will eventually make to `getAccentureHoverData`'s `rn_latest` window
 * only becomes correct once this write-side half exists, which is why it's
 * built here first and the read-side file is held for separate sign-off.
 *
 * POST-CUTOFF FREEZE GUARD: `cutoffExclusiveUtc` is computed from THIS
 * file's own last report date every run (never a hardcoded date) — a field
 * is "frozen" when the single most recent `candidate_sync_changes` row for
 * that (candidate_master_id, field_name), of ANY kind, has `changed_at >=`
 * that cutoff. A frozen field still gets every real step logged (history
 * is never gated), it just never gets `wouldWriteLive` and so its live
 * column is left alone.
 *
 * IDEMPOTENCY: per (cid, field_name), the "already replayed through"
 * checkpoint is DERIVED from existing `candidate_sync_changes` history
 * (the latest row whose run has `kind = 'accenture_upload'`) rather than
 * tracked in a new column/table — zero migration. Only occurrences
 * strictly after that checkpoint's date are walked; the checkpoint's own
 * `new_value` (not the live `candidate_master` column, which may be frozen
 * and therefore stale relative to replay) seeds the walk.
 */
import {
  getCandidateMasterRowsByCids,
  type CandidateMasterRow,
  type SqlClient,
} from "@/services/persistence/read-candidate-master";
import { coerceBlank, todayAsDdMmYyyy, writeChange, writeReviewFlag } from "./candidate-sync-engine";
import { extractJmlNumber, formatJmlAsLegacy } from "./candidate-jml-format";
import { accentureReportDateKey, istEndOfDayExclusiveUtc, parseAccentureReportDate } from "./candidate-excel-date";
import { planAccentureFileGroups } from "./candidate-accenture-engine";
import type { CandidateAccentureParsedRow } from "./candidate-accenture-parser";

const SYNCED_DB_FIELDS = [
  "email",
  "job_management_level",
  "accenture_candidate_stage",
  "current_cid_source",
  "application_completion_status",
] as const;
type SyncedDbField = (typeof SYNCED_DB_FIELDS)[number];

function normalizeNameForMatch(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

interface DatedRow extends CandidateAccentureParsedRow {
  reportDateKey: string;
  reportDateIst: Date;
}

/** Attaches a parsed date to every row with one, drops rows whose Date cell didn't parse, then same-day-dedupes (last row in file order per date wins) and sorts ascending. Pure. */
function prepareDatedGroup(groupRows: CandidateAccentureParsedRow[]): {
  rows: DatedRow[];
  sameDayDuplicateRowCount: number;
} {
  const withDates: DatedRow[] = [];
  for (const row of groupRows) {
    const key = accentureReportDateKey(row.reportDateRaw);
    const ist = parseAccentureReportDate(row.reportDateRaw);
    if (key === null || ist === null) continue;
    withDates.push({ ...row, reportDateKey: key, reportDateIst: ist });
  }
  const byDate = new Map<string, DatedRow>();
  const order: string[] = [];
  for (const row of withDates) {
    if (!byDate.has(row.reportDateKey)) order.push(row.reportDateKey);
    byDate.set(row.reportDateKey, row);
  }
  const rows = order.map((k) => byDate.get(k)!).sort((a, b) => a.reportDateIst.getTime() - b.reportDateIst.getTime());
  return { rows, sameDayDuplicateRowCount: withDates.length - rows.length };
}

export interface CandidateAccentureOccurrence {
  value: string;
  changedAt: Date;
  /** The true file report date ("YYYY-MM-DD"), independent of `changedAt` — see migration 024's doc comment for why these two can differ for the one live-write step per run. */
  reportDateKey: string;
}

function emailOccurrences(rows: DatedRow[]): CandidateAccentureOccurrence[] {
  return rows
    .filter((r) => r.email.trim() !== "" && r.email.trim() !== "-")
    .map((r) => ({ value: r.email.trim(), changedAt: r.reportDateIst, reportDateKey: r.reportDateKey }));
}
function levelOccurrences(rows: DatedRow[]): CandidateAccentureOccurrence[] {
  const out: CandidateAccentureOccurrence[] = [];
  for (const r of rows) {
    const n = extractJmlNumber(r.level);
    if (n !== null) out.push({ value: formatJmlAsLegacy(n), changedAt: r.reportDateIst, reportDateKey: r.reportDateKey });
  }
  return out;
}
function snapshotOccurrences(
  rows: DatedRow[],
  pick: (r: DatedRow) => string
): CandidateAccentureOccurrence[] {
  return rows
    .map((r) => ({ value: pick(r).trim(), changedAt: r.reportDateIst, reportDateKey: r.reportDateKey }))
    .filter((o) => o.value !== "" && o.value !== "-");
}
function normalizeStoredLevel(stored: string): string {
  const n = extractJmlNumber(stored);
  return n !== null ? formatJmlAsLegacy(n) : stored;
}

function buildOccurrencesByField(rows: DatedRow[]): Record<SyncedDbField, CandidateAccentureOccurrence[]> {
  return {
    email: emailOccurrences(rows),
    job_management_level: levelOccurrences(rows),
    accenture_candidate_stage: snapshotOccurrences(rows, (r) => r.candidateStage),
    current_cid_source: snapshotOccurrences(rows, (r) => r.currentCidSource),
    application_completion_status: snapshotOccurrences(rows, (r) => r.applicationCompletionStatus),
  };
}

export interface CandidateAccentureReplayStep {
  oldValue: string;
  newValue: string;
  changedAt: Date;
  /** The true file report date for THIS step, NEVER re-stamped — unlike `changedAt`, which the live-write step overrides with real time for ordering (see migration 024's doc comment). This is what the history modal displays. */
  reportDateKey: string;
}

export interface CandidateAccentureReplayFieldResult {
  steps: CandidateAccentureReplayStep[];
  finalValue: string;
  wouldWriteLive: boolean;
}

function keyOf(value: string, caseInsensitive: boolean): string {
  return caseInsensitive ? value.toLowerCase() : value;
}

/**
 * Walks `[seed, ...occurrences]`, logging one step per adjacent pair that
 * differs under the field's equality rule (case-insensitive for email,
 * exact otherwise) — every real step, including reverts, with NO
 * final-equals-seed short-circuit (unlike the classic engine's
 * `computeAccentureFieldChain`, which this deliberately does not call or
 * share logic with). `frozen: true` forces `wouldWriteLive: false`
 * regardless of whether the final value differs from the seed — history
 * is still fully logged either way. When `wouldWriteLive` is true, the
 * LAST logged step (which is guaranteed to exist whenever the final value
 * differs from the seed, since equality here is transitive) is re-stamped
 * with `liveWriteAt` instead of its true file date — see the module
 * doc comment's "LATEST-WRITER ORDERING" section for why.
 */
export function computeAccentureReplayFieldChain(
  seed: string,
  occurrences: CandidateAccentureOccurrence[],
  options: { frozen: boolean; liveWriteAt: Date; caseInsensitive?: boolean }
): CandidateAccentureReplayFieldResult {
  const caseInsensitive = options.caseInsensitive ?? false;
  const values = [seed, ...occurrences.map((o) => o.value)];
  const steps: CandidateAccentureReplayStep[] = [];
  for (let i = 1; i < values.length; i += 1) {
    if (keyOf(values[i], caseInsensitive) !== keyOf(values[i - 1], caseInsensitive)) {
      steps.push({
        oldValue: values[i - 1],
        newValue: values[i],
        changedAt: occurrences[i - 1].changedAt,
        reportDateKey: occurrences[i - 1].reportDateKey,
      });
    }
  }
  const finalValue = values[values.length - 1];
  const wouldWriteLive =
    !options.frozen && keyOf(finalValue, caseInsensitive) !== keyOf(seed, caseInsensitive);
  if (wouldWriteLive && steps.length > 0) {
    // Only `changedAt` (ordering) is re-stamped with real time — `reportDateKey` keeps the true file date for display, always.
    steps[steps.length - 1] = { ...steps[steps.length - 1], changedAt: options.liveWriteAt };
  }
  return { steps, finalValue, wouldWriteLive };
}

/** A pending candidate_sync_changes row, collected in memory and flushed in batches (see insertStepsBatched). */
interface PendingStepRow {
  sync_id: number;
  cid: string;
  field_name: string;
  old_value: string;
  new_value: string;
  candidate_master_id: number;
  changed_at: Date;
  report_date: string;
}

const STEP_INSERT_CHUNK_SIZE = 2000;

/**
 * The `postgres` package's bulk-insert helper (`sql(array, ...columns)`) is
 * correctly typed on its own, but interpolating its result into a tagged
 * template called through this codebase's `SqlClient` union type (plain
 * `Sql<{}> | TransactionSql<{}>`, used everywhere, not just here) trips a
 * readonly-vs-mutable variance mismatch purely in the type checker — the
 * runtime value `sql(...)` produces is the same regardless. The `as any`
 * here is exactly that: a type-level-only workaround, isolated to this one
 * interpolation, not a loosening of anything that affects the generated
 * SQL or its parameters.
 */
async function insertStepsBatched(sqlClient: SqlClient, steps: PendingStepRow[]): Promise<void> {
  for (let i = 0; i < steps.length; i += STEP_INSERT_CHUNK_SIZE) {
    const chunk = steps.slice(i, i + STEP_INSERT_CHUNK_SIZE);
    const values = sqlClient(
      chunk,
      "sync_id",
      "cid",
      "field_name",
      "old_value",
      "new_value",
      "candidate_master_id",
      "changed_at",
      "report_date"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see doc comment above
    ) as any;
    await sqlClient`
      INSERT INTO candidate_sync_changes ${values}
    `;
  }
}

interface CheckpointEntry {
  /**
   * The true file report date ("YYYY-MM-DD") of the checkpoint row — NOT
   * its `changed_at` — used as the boundary for "which occurrences are
   * new." Using `changed_at` here was a real bug, found by rehearsing a
   * genuine follow-up upload (not just a re-upload of the same file):
   * the live-write step's `changed_at` is stamped with REAL time, so a
   * later file's occurrences dated shortly after the FIRST file's last
   * date — but still before the real wall-clock moment the first upload
   * actually ran — were wrongly treated as "already seen" and silently
   * skipped. `report_date` never gets re-stamped (see migration 024), so
   * it's the correct, stable boundary.
   */
  reportDateKey: string;
  newValue: string;
}
/** Per (cid, field_name): the latest accenture_upload-sourced step ever logged for it — the idempotency checkpoint. One batched query for the whole file. */
async function loadCheckpoints(
  sqlClient: SqlClient,
  cids: string[]
): Promise<Map<string, Map<SyncedDbField, CheckpointEntry>>> {
  const result = new Map<string, Map<SyncedDbField, CheckpointEntry>>();
  if (cids.length === 0) return result;
  const rows = await sqlClient<
    { cid: string; field_name: string; report_date: string | null; new_value: string | null }[]
  >`
    SELECT DISTINCT ON (csc.cid, csc.field_name) csc.cid, csc.field_name, csc.report_date, csc.new_value
    FROM candidate_sync_changes csc
    JOIN candidate_sync_history csh ON csh.id = csc.sync_id
    WHERE csh.kind = 'accenture_upload'
      AND csc.field_name = ANY(${[...SYNCED_DB_FIELDS]})
      AND csc.cid = ANY(${cids})
    ORDER BY csc.cid, csc.field_name, csc.changed_at DESC, csc.id DESC
  `;
  for (const row of rows) {
    if (!row.report_date) continue; // defensive: every replay-mode step always sets it, but a row without one can't anchor a boundary
    const byField = result.get(row.cid) ?? new Map<SyncedDbField, CheckpointEntry>();
    byField.set(row.field_name as SyncedDbField, {
      reportDateKey: row.report_date,
      newValue: row.new_value ?? "-",
    });
    result.set(row.cid, byField);
  }
  return result;
}

/**
 * Per matched candidate_master.id: whether each synced field is frozen —
 * its latest NON-Accenture step (Oorwin/manual/other), if any, is on/after
 * the cutoff. One batched query for the whole file.
 *
 * Deliberately excludes `kind = 'accenture_upload'` rows from this check —
 * found by rehearsing a second upload of the same file against a throwaway
 * DB already populated by a first apply. The live-write step from THAT
 * first run is stamped with a real "now" timestamp (see
 * computeAccentureReplayFieldChain's doc comment), which is almost always
 * after any file's cutoff — checking "any kind" here meant every field
 * Accenture had ever actually written would immediately freeze itself out
 * on the very next upload, blocking all future replay. Only a genuinely
 * different source (a human, or Oorwin) editing a field after the file's
 * own date range should ever freeze it; Accenture's own past writes,
 * backdated or real-time, are what this engine is maintaining and must
 * never block its own later runs.
 */
async function loadFrozenFields(
  sqlClient: SqlClient,
  candidateMasterIds: number[],
  cutoffExclusiveUtc: Date
): Promise<Map<number, Set<SyncedDbField>>> {
  const result = new Map<number, Set<SyncedDbField>>();
  if (candidateMasterIds.length === 0) return result;
  const rows = await sqlClient<{ candidate_master_id: number | string; field_name: string; changed_at: string }[]>`
    SELECT DISTINCT ON (csc.candidate_master_id, csc.field_name) csc.candidate_master_id, csc.field_name, csc.changed_at
    FROM candidate_sync_changes csc
    LEFT JOIN candidate_sync_history csh ON csh.id = csc.sync_id
    WHERE csc.field_name = ANY(${[...SYNCED_DB_FIELDS]})
      AND csc.candidate_master_id = ANY(${candidateMasterIds})
      AND csh.kind IS DISTINCT FROM 'accenture_upload'
    ORDER BY csc.candidate_master_id, csc.field_name, csc.changed_at DESC, csc.id DESC
  `;
  for (const row of rows) {
    if (new Date(row.changed_at).getTime() < cutoffExclusiveUtc.getTime()) continue;
    // candidate_master_id is BIGINT — the `postgres` driver returns it as a
    // string, so this MUST be coerced before using it as a Map key, or a
    // lookup by the real numeric id (existing.id) silently misses forever.
    const id = Number(row.candidate_master_id);
    const set = result.get(id) ?? new Set<SyncedDbField>();
    set.add(row.field_name as SyncedDbField);
    result.set(id, set);
  }
  return result;
}

export interface CandidateAccentureReplaySyncSummary {
  rowsInSheet: number;
  fileLastDateKey: string | null;
  uniqueCidCount: number;
  matchedCidCount: number;
  matchedRowCount: number;
  insertedCount: number;
  skippedBlankCidCount: number;
  invalidCidCount: number;
  sameDayDuplicateRowCount: number;
  reviewFlagCount: number;
  historyRowCount: number;
  fieldChangeCounts: Record<SyncedDbField, number>;
  frozenFieldCount: number;
  nameMismatchNotesCount: number;
  newlyLockedCount: { email: number; job_management_level: number };
}

const EMPTY_FIELD_COUNTS: Record<SyncedDbField, number> = {
  email: 0,
  job_management_level: 0,
  accenture_candidate_stage: 0,
  current_cid_source: 0,
  application_completion_status: 0,
};

/**
 * Runs the whole-file replay. `dryRun: true` performs every read and every
 * diff computation but never calls a write statement — same discipline as
 * the classic engine's `runCandidateAccentureSync`.
 */
export async function runCandidateAccentureReplaySync(
  parsedRows: CandidateAccentureParsedRow[],
  syncId: number | null,
  sqlClient: SqlClient,
  options: { dryRun?: boolean } = {}
): Promise<CandidateAccentureReplaySyncSummary> {
  const dryRun = options.dryRun ?? false;
  const liveWriteAt = new Date();

  const fileDateKeys = parsedRows
    .map((r) => accentureReportDateKey(r.reportDateRaw))
    .filter((k): k is string => k !== null)
    .sort();
  const fileLastDateKey = fileDateKeys.length > 0 ? fileDateKeys[fileDateKeys.length - 1] : null;
  const cutoffExclusiveUtc = fileLastDateKey ? istEndOfDayExclusiveUtc(fileLastDateKey) : new Date(8640000000000000);

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

  const datedGroups = new Map<string, { rows: DatedRow[]; sameDayDuplicateRowCount: number }>();
  let sameDayDuplicateRowCount = 0;
  for (const cid of plan.groupOrder) {
    const prepared = prepareDatedGroup(plan.groups.get(cid)!);
    datedGroups.set(cid, prepared);
    sameDayDuplicateRowCount += prepared.sameDayDuplicateRowCount;
  }

  const existingByCid = new Map<string, CandidateMasterRow[]>();
  for (const row of await getCandidateMasterRowsByCids(plan.groupOrder, sqlClient)) {
    const list = existingByCid.get(row.cid) ?? [];
    list.push(row);
    existingByCid.set(row.cid, list);
  }

  const matchedCids = plan.groupOrder.filter((cid) => (existingByCid.get(cid)?.length ?? 0) > 0);
  const checkpoints = await loadCheckpoints(sqlClient, matchedCids);
  const matchedIds = matchedCids.flatMap((cid) => existingByCid.get(cid)!.map((r) => r.id));
  const frozenByRowId = await loadFrozenFields(sqlClient, matchedIds, cutoffExclusiveUtc);

  const pendingSteps: PendingStepRow[] = [];
  const fieldChangeCounts: Record<SyncedDbField, number> = { ...EMPTY_FIELD_COUNTS };
  let frozenFieldCount = 0;
  let nameMismatchNotesCount = 0;
  const newlyLockedCount = { email: 0, job_management_level: 0 };
  let matchedCidCount = 0;
  let matchedRowCount = 0;
  let insertedCount = 0;
  let insertContinuationStepCount = 0;

  interface PendingInsert {
    cid: string;
    firstRow: DatedRow;
    lastCidDateKey: string;
    insertValues: Record<SyncedDbField, string>;
    continuationResults: Record<SyncedDbField, CandidateAccentureReplayFieldResult>;
    nameMismatch: boolean;
    lastFileName: string;
    insertedName: string;
  }
  const pendingInserts: PendingInsert[] = [];

  for (const cid of plan.groupOrder) {
    const { rows } = datedGroups.get(cid)!;
    if (rows.length === 0) continue;
    const occ = buildOccurrencesByField(rows);
    const existingRows = existingByCid.get(cid) ?? [];

    if (existingRows.length === 0) {
      insertedCount += 1;
      const firstRow = rows[0];
      const insertValues: Record<SyncedDbField, string> = {
        email: occ.email.length > 0 ? occ.email[0].value : "-",
        job_management_level: occ.job_management_level.length > 0 ? occ.job_management_level[0].value : "-",
        accenture_candidate_stage:
          occ.accenture_candidate_stage.length > 0 ? occ.accenture_candidate_stage[0].value : "-",
        current_cid_source: occ.current_cid_source.length > 0 ? occ.current_cid_source[0].value : "-",
        application_completion_status:
          occ.application_completion_status.length > 0 ? occ.application_completion_status[0].value : "-",
      };
      if (insertValues.email !== "-") newlyLockedCount.email += 1;
      if (insertValues.job_management_level !== "-") newlyLockedCount.job_management_level += 1;

      const continuationResults: Record<SyncedDbField, CandidateAccentureReplayFieldResult> = {
        email: computeAccentureReplayFieldChain(insertValues.email, occ.email.slice(1), {
          frozen: false,
          liveWriteAt,
          caseInsensitive: true,
        }),
        job_management_level: computeAccentureReplayFieldChain(
          insertValues.job_management_level,
          occ.job_management_level.slice(1),
          { frozen: false, liveWriteAt }
        ),
        accenture_candidate_stage: computeAccentureReplayFieldChain(
          insertValues.accenture_candidate_stage,
          occ.accenture_candidate_stage.slice(1),
          { frozen: false, liveWriteAt }
        ),
        current_cid_source: computeAccentureReplayFieldChain(
          insertValues.current_cid_source,
          occ.current_cid_source.slice(1),
          { frozen: false, liveWriteAt }
        ),
        application_completion_status: computeAccentureReplayFieldChain(
          insertValues.application_completion_status,
          occ.application_completion_status.slice(1),
          { frozen: false, liveWriteAt }
        ),
      };
      for (const field of SYNCED_DB_FIELDS) {
        if (continuationResults[field].wouldWriteLive) fieldChangeCounts[field] += 1;
        // Counted here unconditionally (dry run or not) because the actual
        // INSERT — and therefore the real ids the steps below need — only
        // happens later, inside the `!dryRun` batch-insert block. Without
        // this, a dry-run preview's historyRowCount silently excluded every
        // continuation step from a brand-new multi-occurrence CID, even
        // though `--apply` would really write them.
        insertContinuationStepCount += continuationResults[field].steps.length;
      }
      // A brand-new CID's name is written literally from the FIRST
      // occurrence (there's no prior name to protect yet) — but if a LATER
      // occurrence in this same group reports a different name, that's the
      // same mismatch-note case a matched row would get, just one step
      // earlier in the row's life. Missing this here meant it silently
      // surfaced one run later instead (the row's very next upload, once
      // matched, ran the check for the first time) — found by rehearsing
      // a byte-identical second upload of the real file and seeing
      // non-zero nameMismatchNotesCount where 0 was expected.
      const insertedName = coerceBlank(firstRow.name);
      const lastFileName = rows[rows.length - 1].name.trim();
      const nameMismatch = lastFileName !== "" && normalizeNameForMatch(lastFileName) !== normalizeNameForMatch(insertedName);
      // Brand-new row: there is no prior note to dedupe against, so every
      // mismatch here is new by definition — counted unconditionally
      // (dry run or not), same reasoning as insertContinuationStepCount.
      if (nameMismatch) nameMismatchNotesCount += 1;
      pendingInserts.push({
        cid,
        firstRow,
        lastCidDateKey: rows[rows.length - 1].reportDateKey,
        insertValues,
        continuationResults,
        nameMismatch,
        lastFileName,
        insertedName,
      });
      continue;
    }

    matchedCidCount += 1;
    matchedRowCount += existingRows.length;

    for (const existing of existingRows) {
      const checkpointForCid = checkpoints.get(cid);
      const frozenForRow = frozenByRowId.get(existing.id) ?? new Set<SyncedDbField>();

      const fieldResults: Record<SyncedDbField, CandidateAccentureReplayFieldResult> = {} as Record<
        SyncedDbField,
        CandidateAccentureReplayFieldResult
      >;
      const usableThisRun: Record<SyncedDbField, boolean> = {} as Record<SyncedDbField, boolean>;

      // CID-level backstop (migration 023): when a field has no per-field
      // checkpoint (no real step was ever logged for it — see that
      // migration's doc comment), but this CID WAS touched by a past
      // Accenture run, every occurrence through that run's own last date
      // for this CID has already been considered for every field
      // uniformly. Without this, a field that happened to be a true no-op
      // in every past run would have its full occurrence history re-walked
      // from whatever the live column currently holds — which could by now
      // be an unrelated, later manual edit — on every subsequent upload.
      const cidLevelBackstopDateKey = existing.last_accenture_report_date ?? null;

      const seedFor = (field: SyncedDbField): string => {
        const checkpoint = checkpointForCid?.get(field);
        if (checkpoint) return checkpoint.newValue;
        if (field === "job_management_level") return normalizeStoredLevel(existing.job_management_level);
        return existing[field];
      };

      for (const field of SYNCED_DB_FIELDS) {
        const checkpoint = checkpointForCid?.get(field);
        // Compared by the true file report date (string, "YYYY-MM-DD" sorts
        // correctly lexically) — NEVER by changedAt, which the live-write
        // step stamps with real time (see CheckpointEntry's doc comment).
        const boundaryDateKey = checkpoint?.reportDateKey ?? cidLevelBackstopDateKey;
        const allOcc = occ[field];
        const filteredOcc = boundaryDateKey ? allOcc.filter((o) => o.reportDateKey > boundaryDateKey) : allOcc;
        usableThisRun[field] = filteredOcc.length > 0;
        const frozen = frozenForRow.has(field);
        if (frozen) frozenFieldCount += 1;
        fieldResults[field] = computeAccentureReplayFieldChain(seedFor(field), filteredOcc, {
          frozen,
          liveWriteAt,
          caseInsensitive: field === "email",
        });
      }

      for (const field of SYNCED_DB_FIELDS) {
        for (const step of fieldResults[field].steps) {
          pendingSteps.push({
            sync_id: syncId as number,
            cid: existing.cid,
            field_name: field,
            old_value: step.oldValue,
            new_value: step.newValue,
            candidate_master_id: existing.id,
            changed_at: step.changedAt,
            report_date: step.reportDateKey,
          });
        }
        if (fieldResults[field].wouldWriteLive) fieldChangeCounts[field] += 1;
      }

      if (!existing.email_accenture_locked && usableThisRun.email) newlyLockedCount.email += 1;
      if (!existing.job_management_level_accenture_locked && usableThisRun.job_management_level) {
        newlyLockedCount.job_management_level += 1;
      }

      const lastFileName = rows[rows.length - 1]?.name.trim() ?? "";
      const nameMismatch = lastFileName !== "" && normalizeNameForMatch(lastFileName) !== normalizeNameForMatch(existing.name);
      let nameMismatchWritten = false;
      if (nameMismatch) {
        if (!dryRun) {
          const latestNoteRows = await sqlClient<{ new_value: string | null }[]>`
            SELECT new_value FROM candidate_sync_changes
            WHERE candidate_master_id = ${existing.id} AND field_name = 'name'
            ORDER BY id DESC LIMIT 1
          `;
          const latestNote = latestNoteRows[0];
          if (!latestNote || latestNote.new_value !== lastFileName) {
            await writeChange(sqlClient, syncId as number, existing.cid, "name", existing.name, lastFileName, existing.id, liveWriteAt);
            nameMismatchWritten = true;
          }
        } else {
          const latestNoteRows = await sqlClient<{ new_value: string | null }[]>`
            SELECT new_value FROM candidate_sync_changes
            WHERE candidate_master_id = ${existing.id} AND field_name = 'name'
            ORDER BY id DESC LIMIT 1
          `;
          const latestNote = latestNoteRows[0];
          if (!latestNote || latestNote.new_value !== lastFileName) nameMismatchWritten = true;
        }
      }
      if (nameMismatchWritten) nameMismatchNotesCount += 1;

      const newEmailLocked = existing.email_accenture_locked || usableThisRun.email;
      const newLevelLocked = existing.job_management_level_accenture_locked || usableThisRun.job_management_level;
      const anyFieldChanged = SYNCED_DB_FIELDS.some((f) => fieldResults[f].wouldWriteLive);
      // Set unconditionally on EVERY touch, same discipline as
      // last_accenture_sync_id — this is the migration 023 backstop a
      // future run falls back to for any field that turns out to have
      // zero real steps in THIS run.
      const lastCidDateKey = rows[rows.length - 1].reportDateKey;

      if (!dryRun) {
        if (anyFieldChanged) {
          await sqlClient`
            UPDATE candidate_master SET
              email = ${fieldResults.email.wouldWriteLive ? fieldResults.email.finalValue : existing.email},
              job_management_level = ${
                fieldResults.job_management_level.wouldWriteLive
                  ? fieldResults.job_management_level.finalValue
                  : existing.job_management_level
              },
              accenture_candidate_stage = ${
                fieldResults.accenture_candidate_stage.wouldWriteLive
                  ? fieldResults.accenture_candidate_stage.finalValue
                  : existing.accenture_candidate_stage
              },
              current_cid_source = ${
                fieldResults.current_cid_source.wouldWriteLive
                  ? fieldResults.current_cid_source.finalValue
                  : existing.current_cid_source
              },
              application_completion_status = ${
                fieldResults.application_completion_status.wouldWriteLive
                  ? fieldResults.application_completion_status.finalValue
                  : existing.application_completion_status
              },
              email_accenture_locked = ${newEmailLocked},
              job_management_level_accenture_locked = ${newLevelLocked},
              last_accenture_sync_id = ${syncId},
              last_accenture_report_date = ${lastCidDateKey},
              last_touched_at = NOW()
            WHERE id = ${existing.id}
          `;
        } else {
          await sqlClient`
            UPDATE candidate_master SET
              email_accenture_locked = ${newEmailLocked},
              job_management_level_accenture_locked = ${newLevelLocked},
              last_accenture_sync_id = ${syncId},
              last_accenture_report_date = ${lastCidDateKey}
            WHERE id = ${existing.id}
          `;
        }
      }
    }
  }

  // Inserts: one batched multi-row INSERT with RETURNING, so continuation
  // steps (which need the new row's id) can be built right after. Every
  // column this table has but this engine never populates is a literal
  // '-' per row (same placeholder convention as the classic engine's
  // applyInsertRow), so the whole row — not just the Accenture-owned
  // columns — is built up front and fed to the bulk-insert helper as-is.
  if (!dryRun && pendingInserts.length > 0) {
    const insertRows = pendingInserts.map((p) => ({
      cid: p.cid,
      name: coerceBlank(p.firstRow.name),
      gender: "-",
      contact_number: "-",
      date_of_upload: todayAsDdMmYyyy(),
      submitter: "-",
      customer: "-",
      job_requisition_id: "-",
      primary_skills: "-",
      job_management_level: p.insertValues.job_management_level,
      market: "-",
      client_spoc: "-",
      status: "-",
      accenture_candidate_stage: p.insertValues.accenture_candidate_stage,
      current_cid_source: p.insertValues.current_cid_source,
      application_completion_status: p.insertValues.application_completion_status,
      screening_candidate_stage: "-",
      disposition_reason: "-",
      submitted_date: "-",
      submission_comments: "-",
      email: p.insertValues.email,
      email_accenture_locked: p.insertValues.email !== "-",
      job_management_level_accenture_locked: p.insertValues.job_management_level !== "-",
      inserted_sync_id: syncId as number,
      last_accenture_sync_id: syncId as number,
      last_accenture_report_date: p.lastCidDateKey,
      last_touched_at: liveWriteAt,
    }));
    // See insertStepsBatched's doc comment for why this is `as any` —
    // type-level-only workaround for the same union-SqlClient variance quirk.
    const insertValuesFragment = sqlClient(
      insertRows,
      "cid",
      "name",
      "gender",
      "contact_number",
      "date_of_upload",
      "submitter",
      "customer",
      "job_requisition_id",
      "primary_skills",
      "job_management_level",
      "market",
      "client_spoc",
      "status",
      "accenture_candidate_stage",
      "current_cid_source",
      "application_completion_status",
      "screening_candidate_stage",
      "disposition_reason",
      "submitted_date",
      "submission_comments",
      "email",
      "email_accenture_locked",
      "job_management_level_accenture_locked",
      "inserted_sync_id",
      "last_accenture_sync_id",
      "last_accenture_report_date",
      "last_touched_at"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any;
    const inserted = await sqlClient<{ id: number; cid: string }[]>`
      INSERT INTO candidate_master ${insertValuesFragment}
      RETURNING id, cid
    `;
    const idByCid = new Map<string, number>(inserted.map((r) => [r.cid, r.id]));
    for (const p of pendingInserts) {
      const id = idByCid.get(p.cid);
      if (id === undefined) continue;
      if (p.nameMismatch) {
        // Direct writeChange (not batched), matching the matched-row
        // path's convention — keeps `historyRowCount` meaning "field-change
        // steps only" consistently across both paths; nameMismatchNotesCount
        // is always the separate total for name notes either way.
        await writeChange(sqlClient, syncId as number, p.cid, "name", p.insertedName, p.lastFileName, id, liveWriteAt);
      }
      for (const field of SYNCED_DB_FIELDS) {
        for (const step of p.continuationResults[field].steps) {
          pendingSteps.push({
            sync_id: syncId as number,
            cid: p.cid,
            field_name: field,
            old_value: step.oldValue,
            new_value: step.newValue,
            candidate_master_id: id,
            changed_at: step.changedAt,
            report_date: step.reportDateKey,
          });
        }
      }
      // The row was inserted with the group's FIRST-occurrence values; any
      // LATER occurrence in the same new-CID group (continuation) that
      // produced a real change must still land on the live column — the
      // steps above only log history, they never touch candidate_master.
      const anyContinuationChanged = SYNCED_DB_FIELDS.some((f) => p.continuationResults[f].wouldWriteLive);
      if (anyContinuationChanged) {
        await sqlClient`
          UPDATE candidate_master SET
            email = ${p.continuationResults.email.wouldWriteLive ? p.continuationResults.email.finalValue : p.insertValues.email},
            job_management_level = ${
              p.continuationResults.job_management_level.wouldWriteLive
                ? p.continuationResults.job_management_level.finalValue
                : p.insertValues.job_management_level
            },
            accenture_candidate_stage = ${
              p.continuationResults.accenture_candidate_stage.wouldWriteLive
                ? p.continuationResults.accenture_candidate_stage.finalValue
                : p.insertValues.accenture_candidate_stage
            },
            current_cid_source = ${
              p.continuationResults.current_cid_source.wouldWriteLive
                ? p.continuationResults.current_cid_source.finalValue
                : p.insertValues.current_cid_source
            },
            application_completion_status = ${
              p.continuationResults.application_completion_status.wouldWriteLive
                ? p.continuationResults.application_completion_status.finalValue
                : p.insertValues.application_completion_status
            }
          WHERE id = ${id}
        `;
      }
    }
  }

  if (!dryRun) {
    await insertStepsBatched(sqlClient, pendingSteps);
  }

  return {
    rowsInSheet: parsedRows.length,
    fileLastDateKey,
    uniqueCidCount: plan.groupOrder.length,
    matchedCidCount,
    matchedRowCount,
    insertedCount,
    skippedBlankCidCount: plan.skippedBlankCidCount,
    invalidCidCount: plan.invalidCidRows.length,
    sameDayDuplicateRowCount,
    reviewFlagCount,
    // In a real apply, insert continuation steps are already inside
    // pendingSteps by this point (added once real ids exist, see the
    // batch-insert block above) — adding insertContinuationStepCount again
    // would double-count them. In a dry run that block never runs, so
    // pendingSteps is missing them entirely; add them back for an accurate
    // preview of what --apply would actually write.
    historyRowCount: pendingSteps.length + (dryRun ? insertContinuationStepCount : 0),
    fieldChangeCounts,
    frozenFieldCount,
    nameMismatchNotesCount,
    newlyLockedCount,
  };
}
