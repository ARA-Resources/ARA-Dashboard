/**
 * Core compare/update engine for the Candidate Master Sheet Oorwin sync.
 *
 * Given the rows parsed from one Oorwin sheet (candidate-oorwin-parser.ts)
 * and a `sync_id` (an already-created `candidate_sync_history` row — the
 * caller/orchestrator's job, see C6), this:
 *
 *  1. Dedupes CIDs that appear more than once WITHIN the sheet:
 *     - Combined Name matches (case-insensitive, trimmed) across every
 *       occurrence → treat as the same person, keep the LAST row in sheet
 *       order.
 *     - Names don't all match → quarantine every row in that CID group
 *       (candidate_review_flags, reason 'duplicate_name_mismatch') and
 *       exclude them from normal processing. The rest of the sheet still
 *       processes normally (partial-batch quarantine, not a whole-batch
 *       reject).
 *  2. For every surviving CID: not in candidate_master → insert (Upload
 *     Date = today, never touched again). In candidate_master → run the
 *     unified auto-fetch resolver for the 4 lookup fields, diff all 14
 *     Oorwin-driven fields against the stored row, update only the changed
 *     ones, record each change in candidate_sync_changes, stamp
 *     last_touched_at. No changes → true no-op (last_touched_at untouched —
 *     the sort rule is "new or updated", not "present in the sheet").
 *  3. A JR-ID auto-fetch conflict on an UPDATE never overwrites the
 *     existing stored value for that one field (per the "do not silently
 *     prefer either table" rule) — it's excluded from that row's diff, but
 *     a jr_id_conflict review flag is still written every run it recurs,
 *     same append-only philosophy as candidate_sync_changes. On an INSERT
 *     there's no prior value to preserve, so a conflicted field is left
 *     "-" (still flagged).
 *  4. CIDs in candidate_master but absent from the sheet: completely
 *     untouched — a true no-op, not a status flip.
 *  5. A live row whose Mobile doesn't cleanly reduce to 10 digits also gets
 *     an 'unclean_contact_number' review flag (raw value still stored, not
 *     rejected) — same append-only, flag-every-recurrence philosophy as
 *     jr_id_conflict (migration 017).
 *  6. A non-blank CID that doesn't match "C" + one or more digits is
 *     quarantined — same mechanism as duplicate_name_mismatch (excluded
 *     from candidate_master entirely, review flag written with reason
 *     'invalid_candidate_id') — because CID is the sole matching key for
 *     every future sync, and a malformed one can never be reliably
 *     re-matched later. This is stricter than blank-CID handling: a blank
 *     CID is silently skipped (nothing to work with), but a non-blank,
 *     wrong-shaped CID is surfaced for review since someone likely typed or
 *     pasted something into the wrong column (migration 018).
 *  7. A live row whose Job Requisition ID is blank/"-" gets a
 *     'missing_job_requisition_id' review flag but is still inserted/
 *     updated normally — JR ID isn't part of the matching key, so unlike
 *     invalid_candidate_id this doesn't block the row (same flag-only
 *     philosophy as unclean_contact_number; migration 018).
 *
 * A row whose CID is blank is skipped entirely (can never be matched by
 * name, no old or new equivalent) — counted separately in the summary
 * rather than silently ignored. Real Oorwin exports observed so far always
 * populate Candidate ID, so this is a defensive path, not an expected one.
 *
 * IMPORTANT for C9 (highlighting UI, not yet built): candidate_review_flags
 * is append-only by design — jr_id_conflict / unclean_contact_number rows
 * accumulate one entry per sync run the issue recurs, so a
 * persistently-unresolved issue has MULTIPLE rows over time. The dashboard
 * must show only rows from the MOST RECENT sync_id per (cid, reason) — NOT
 * one row per (cid, reason) via a naive `DISTINCT ON (cid, reason)`. A
 * single CID can have more than one simultaneous jr_id_conflict (e.g. both
 * job_management_level AND market conflicting at once — proved live in
 * verify-candidate-sync-engine.ts), and `DISTINCT ON (cid, reason)` would
 * silently discard all but one of them. The correct query finds
 * `MAX(sync_id)` per `(cid, reason)`, then joins back for every row matching
 * that exact `(cid, reason, sync_id)` — preserving every simultaneous flag
 * from the latest occurrence while still dropping stale ones from earlier
 * syncs:
 *   SELECT crf.* FROM candidate_review_flags crf
 *   JOIN (SELECT cid, reason, MAX(sync_id) AS latest_sync_id
 *         FROM candidate_review_flags GROUP BY cid, reason) latest
 *     ON crf.cid = latest.cid AND crf.reason = latest.reason
 *    AND crf.sync_id = latest.latest_sync_id
 * Full history stays queryable (unfiltered) for the candidate history
 * popup, same pattern as candidate_sync_changes' "most-recent-sync view,
 * full history preserved."
 */
import {
  getCandidateMasterByCid,
  type CandidateMasterRow,
  type SqlClient,
} from "@/services/persistence/read-candidate-master";
import { getDbClient } from "@/lib/persistence/db-client";
import { resolveCandidateAutoFetchFields } from "./candidate-auto-fetch";
import { combineCandidateName, normalizeCandidateMobile } from "./candidate-field-utils";
import type { CandidateOorwinParsedRow } from "./candidate-oorwin-parser";

/** DB columns diffed/updated by the sync (excludes id/cid/date_of_upload/created_at/updated_at/last_touched_at). */
const DIFFABLE_FIELDS = [
  "name",
  "gender",
  "contact_number",
  "submitter",
  "customer",
  "job_requisition_id",
  "primary_skills",
  "job_management_level",
  "market",
  "client_spoc",
  "status",
  "submitted_date",
  "submission_comments",
  "email",
] as const;

type DiffableField = (typeof DIFFABLE_FIELDS)[number];

export type CandidateSyncRowAction = "inserted" | "updated" | "unchanged";

export interface CandidateSyncRowOutcome {
  cid: string;
  action: CandidateSyncRowAction;
  changedFields: DiffableField[];
}

export interface CandidateSyncSummary {
  rowsInSheet: number;
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
  quarantinedCount: number;
  skippedBlankCidCount: number;
  reviewFlagCount: number;
  outcomes: CandidateSyncRowOutcome[];
}

function coerceBlank(value: string): string {
  const trimmed = value.trim();
  return trimmed === "" ? "-" : trimmed;
}

function isBlankCid(cid: string): boolean {
  const t = cid.trim();
  return t === "" || t === "-";
}

/** Migration 018: a valid CID is "C" followed by one or more digits — nothing else. */
const CID_FORMAT_REGEX = /^C[0-9]+$/;

function isValidCidFormat(cid: string): boolean {
  return CID_FORMAT_REGEX.test(cid.trim());
}

function normalizeNameForMatch(name: string): string {
  return name.trim().toLowerCase();
}

function todayAsDdMmYyyy(): string {
  const now = new Date();
  const d = String(now.getUTCDate()).padStart(2, "0");
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const y = now.getUTCFullYear();
  return `${d}/${m}/${y}`;
}

interface SheetIndexedRow {
  row: CandidateOorwinParsedRow;
  sheetIndex: number;
}

interface DedupePlan {
  survivors: SheetIndexedRow[];
  quarantined: { cid: string; members: SheetIndexedRow[] }[];
  /** Non-blank CID that doesn't match "C" + digits — excluded before dedupe grouping even runs. */
  invalidCid: SheetIndexedRow[];
}

/** Step 1: within-sheet CID dedupe. Pure — no DB access. */
export function planCandidateSheetDedupe(rows: CandidateOorwinParsedRow[]): DedupePlan {
  const groups = new Map<string, SheetIndexedRow[]>();
  const invalidCid: SheetIndexedRow[] = [];
  rows.forEach((row, sheetIndex) => {
    if (isBlankCid(row.cid)) return;
    const key = row.cid.trim();
    if (!isValidCidFormat(key)) {
      invalidCid.push({ row, sheetIndex });
      return;
    }
    const list = groups.get(key) ?? [];
    list.push({ row, sheetIndex });
    groups.set(key, list);
  });

  const survivors: SheetIndexedRow[] = [];
  const quarantined: DedupePlan["quarantined"] = [];

  for (const [cid, members] of groups) {
    if (members.length === 1) {
      survivors.push(members[0]);
      continue;
    }
    const names = new Set(
      members.map((m) => normalizeNameForMatch(combineCandidateName(m.row.firstName, m.row.middleName, m.row.lastName)))
    );
    if (names.size === 1) {
      // Last row in sheet order wins.
      survivors.push(members.reduce((last, m) => (m.sheetIndex > last.sheetIndex ? m : last)));
    } else {
      quarantined.push({ cid, members });
    }
  }

  return { survivors, quarantined, invalidCid };
}

interface DesiredFields {
  values: Record<DiffableField, string>;
  conflictFields: Set<DiffableField>;
  reviewConflicts: { field: DiffableField; lateralValue: string; executiveValue: string }[];
  /** Non-blank Mobile that didn't cleanly reduce to 10 digits — raw value is still stored, but flagged. */
  uncleanContactNumberRaw: string | null;
  /** Job Requisition ID is blank/"-" on this live-sync row — row is still stored, but flagged. */
  missingJobRequisitionId: boolean;
}

/** Builds the desired field values for one row (name combine, mobile normalize, comments fallback, auto-fetch). */
async function buildDesiredFields(
  row: CandidateOorwinParsedRow,
  sqlClient: SqlClient
): Promise<DesiredFields> {
  const mobileRaw = row.mobile.trim();
  const mobile = normalizeCandidateMobile(row.mobile);
  const contactNumber = mobile.ok && mobile.normalized ? mobile.normalized : coerceBlank(row.mobile);
  const uncleanContactNumberRaw =
    !mobile.ok && mobileRaw !== "" && mobileRaw !== "-" ? mobileRaw : null;

  const submissionComments =
    row.submissionComments.trim() !== "" && row.submissionComments.trim() !== "-"
      ? row.submissionComments.trim()
      : coerceBlank(row.reasonForRejection);

  const jobRequisitionId = coerceBlank(row.clientSubmissionJr);
  const missingJobRequisitionId = jobRequisitionId === "-";

  const autoFetch = await resolveCandidateAutoFetchFields(
    row.clientSubmissionJr,
    {
      primarySkills: row.customerJobTitle,
      market: row.market,
      clientSpoc: row.clientSpoc,
    },
    sqlClient
  );

  const conflictFields = new Set<DiffableField>();
  const reviewConflicts: DesiredFields["reviewConflicts"] = [];
  for (const c of autoFetch.conflicts) {
    const field: DiffableField =
      c.field === "primarySkills"
        ? "primary_skills"
        : c.field === "jobManagementLevel"
          ? "job_management_level"
          : c.field === "market"
            ? "market"
            : "client_spoc";
    conflictFields.add(field);
    reviewConflicts.push({ field, lateralValue: c.lateralValue, executiveValue: c.executiveValue });
  }

  const values: Record<DiffableField, string> = {
    name: coerceBlank(combineCandidateName(row.firstName, row.middleName, row.lastName)),
    gender: coerceBlank(row.gender),
    contact_number: contactNumber,
    submitter: coerceBlank(row.submitter),
    customer: coerceBlank(row.customer),
    job_requisition_id: jobRequisitionId,
    primary_skills: conflictFields.has("primary_skills") ? "" : coerceBlank(autoFetch.values.primarySkills ?? "-"),
    job_management_level: conflictFields.has("job_management_level")
      ? ""
      : coerceBlank(autoFetch.values.jobManagementLevel ?? "-"),
    market: conflictFields.has("market") ? "" : coerceBlank(autoFetch.values.market ?? "-"),
    client_spoc: conflictFields.has("client_spoc") ? "" : coerceBlank(autoFetch.values.clientSpoc ?? "-"),
    status: coerceBlank(row.status),
    submitted_date: coerceBlank(row.submittedDate),
    submission_comments: submissionComments,
    email: coerceBlank(row.email),
  };

  return { values, conflictFields, reviewConflicts, uncleanContactNumberRaw, missingJobRequisitionId };
}

type CandidateReviewFlagReason =
  | "duplicate_name_mismatch"
  | "invalid_candidate_id"
  | "jr_id_conflict"
  | "missing_job_requisition_id"
  | "unclean_contact_number";

async function writeReviewFlag(
  sqlClient: SqlClient,
  syncId: number,
  cid: string,
  reason: CandidateReviewFlagReason,
  detail: Record<string, unknown>
): Promise<void> {
  // Round-trip through JSON.stringify/parse to get a plain value the
  // `postgres` package's strict JSONValue type accepts without an unsafe cast.
  await sqlClient`
    INSERT INTO candidate_review_flags (sync_id, cid, reason, detail)
    VALUES (${syncId}, ${cid}, ${reason}, ${sqlClient.json(JSON.parse(JSON.stringify(detail)))})
  `;
}

async function writeChange(
  sqlClient: SqlClient,
  syncId: number,
  cid: string,
  field: string,
  oldValue: string | null,
  newValue: string | null
): Promise<void> {
  await sqlClient`
    INSERT INTO candidate_sync_changes (sync_id, cid, field_name, old_value, new_value)
    VALUES (${syncId}, ${cid}, ${field}, ${oldValue}, ${newValue})
  `;
}

async function processSurvivorRow(
  sqlClient: SqlClient,
  syncId: number,
  row: CandidateOorwinParsedRow
): Promise<{ outcome: CandidateSyncRowOutcome; reviewFlagsWritten: number }> {
  const cid = row.cid.trim();
  const desired = await buildDesiredFields(row, sqlClient);
  let reviewFlagsWritten = 0;

  for (const conflict of desired.reviewConflicts) {
    await writeReviewFlag(sqlClient, syncId, cid, "jr_id_conflict", conflict);
    reviewFlagsWritten += 1;
  }

  if (desired.uncleanContactNumberRaw !== null) {
    await writeReviewFlag(sqlClient, syncId, cid, "unclean_contact_number", {
      raw: desired.uncleanContactNumberRaw,
    });
    reviewFlagsWritten += 1;
  }

  if (desired.missingJobRequisitionId) {
    await writeReviewFlag(sqlClient, syncId, cid, "missing_job_requisition_id", {
      sheetRowNumber: row.sheetRowNumber,
    });
    reviewFlagsWritten += 1;
  }

  const existing = await getCandidateMasterByCid(cid, sqlClient);

  if (!existing) {
    const today = todayAsDdMmYyyy();
    await sqlClient`
      INSERT INTO candidate_master (
        cid, name, gender, contact_number, date_of_upload, submitter, customer,
        job_requisition_id, primary_skills, job_management_level, market,
        client_spoc, status, submitted_date, submission_comments, email,
        last_touched_at
      ) VALUES (
        ${cid}, ${desired.values.name}, ${desired.values.gender}, ${desired.values.contact_number},
        ${today}, ${desired.values.submitter}, ${desired.values.customer},
        ${desired.values.job_requisition_id},
        ${desired.conflictFields.has("primary_skills") ? "-" : desired.values.primary_skills},
        ${desired.conflictFields.has("job_management_level") ? "-" : desired.values.job_management_level},
        ${desired.conflictFields.has("market") ? "-" : desired.values.market},
        ${desired.conflictFields.has("client_spoc") ? "-" : desired.values.client_spoc},
        ${desired.values.status}, ${desired.values.submitted_date}, ${desired.values.submission_comments},
        ${desired.values.email}, NOW()
      )
    `;
    return {
      outcome: { cid, action: "inserted", changedFields: [] },
      reviewFlagsWritten,
    };
  }

  const changedFields: DiffableField[] = [];
  for (const field of DIFFABLE_FIELDS) {
    if (desired.conflictFields.has(field)) continue; // never overwrite on conflict
    const newValue = desired.values[field];
    const oldValue = existing[field as keyof CandidateMasterRow] as string;
    if (newValue !== oldValue) changedFields.push(field);
  }

  if (changedFields.length === 0) {
    return { outcome: { cid, action: "unchanged", changedFields: [] }, reviewFlagsWritten };
  }

  for (const field of changedFields) {
    const oldValue = existing[field as keyof CandidateMasterRow] as string;
    await writeChange(sqlClient, syncId, cid, field, oldValue, desired.values[field]);
  }

  // Every column is set unconditionally rather than building a dynamic
  // partial SET list: conflicted/unchanged fields are set back to their
  // own existing value (a no-op write), so the result is identical to a
  // partial update but the query stays a single static tagged template.
  await sqlClient`
    UPDATE candidate_master SET
      name = ${desired.conflictFields.has("name") ? existing.name : desired.values.name},
      gender = ${desired.conflictFields.has("gender") ? existing.gender : desired.values.gender},
      contact_number = ${desired.conflictFields.has("contact_number") ? existing.contact_number : desired.values.contact_number},
      submitter = ${desired.conflictFields.has("submitter") ? existing.submitter : desired.values.submitter},
      customer = ${desired.conflictFields.has("customer") ? existing.customer : desired.values.customer},
      job_requisition_id = ${desired.conflictFields.has("job_requisition_id") ? existing.job_requisition_id : desired.values.job_requisition_id},
      primary_skills = ${desired.conflictFields.has("primary_skills") ? existing.primary_skills : desired.values.primary_skills},
      job_management_level = ${desired.conflictFields.has("job_management_level") ? existing.job_management_level : desired.values.job_management_level},
      market = ${desired.conflictFields.has("market") ? existing.market : desired.values.market},
      client_spoc = ${desired.conflictFields.has("client_spoc") ? existing.client_spoc : desired.values.client_spoc},
      status = ${desired.conflictFields.has("status") ? existing.status : desired.values.status},
      submitted_date = ${desired.conflictFields.has("submitted_date") ? existing.submitted_date : desired.values.submitted_date},
      submission_comments = ${desired.conflictFields.has("submission_comments") ? existing.submission_comments : desired.values.submission_comments},
      email = ${desired.conflictFields.has("email") ? existing.email : desired.values.email},
      last_touched_at = NOW()
    WHERE cid = ${cid}
  `;

  return {
    outcome: { cid, action: "updated", changedFields },
    reviewFlagsWritten,
  };
}

export async function runCandidateSync(
  parsedRows: CandidateOorwinParsedRow[],
  syncId: number,
  sqlClient?: SqlClient
): Promise<CandidateSyncSummary> {
  const sql = sqlClient ?? getDbClient();
  const skippedBlankCidCount = parsedRows.filter((r) => isBlankCid(r.cid)).length;

  const dedupe = planCandidateSheetDedupe(parsedRows);

  let reviewFlagCount = 0;
  for (const group of dedupe.quarantined) {
    for (const member of group.members) {
      await writeReviewFlag(sql, syncId, group.cid, "duplicate_name_mismatch", {
        sheetRowNumber: member.row.sheetRowNumber,
        name: combineCandidateName(member.row.firstName, member.row.middleName, member.row.lastName),
        groupSheetRowNumbers: group.members.map((m) => m.row.sheetRowNumber),
      });
      reviewFlagCount += 1;
    }
  }

  for (const item of dedupe.invalidCid) {
    await writeReviewFlag(sql, syncId, item.row.cid.trim(), "invalid_candidate_id", {
      sheetRowNumber: item.row.sheetRowNumber,
      name: combineCandidateName(item.row.firstName, item.row.middleName, item.row.lastName),
      rawCid: item.row.cid,
    });
    reviewFlagCount += 1;
  }

  const outcomes: CandidateSyncRowOutcome[] = [];
  let insertedCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  for (const survivor of dedupe.survivors) {
    const { outcome, reviewFlagsWritten } = await processSurvivorRow(sql, syncId, survivor.row);
    outcomes.push(outcome);
    reviewFlagCount += reviewFlagsWritten;
    if (outcome.action === "inserted") insertedCount += 1;
    else if (outcome.action === "updated") updatedCount += 1;
    else unchangedCount += 1;
  }

  const quarantinedCount =
    dedupe.quarantined.reduce((n, g) => n + g.members.length, 0) + dedupe.invalidCid.length;

  return {
    rowsInSheet: parsedRows.length,
    insertedCount,
    updatedCount,
    unchangedCount,
    quarantinedCount,
    skippedBlankCidCount,
    reviewFlagCount,
    outcomes,
  };
}
