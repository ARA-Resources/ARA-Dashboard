/**
 * Candidate Master Sheet — manual Add / Modify / Delete (migration 021).
 *
 * Reuse, deliberately, rather than a parallel implementation:
 *  - CID format check (`isValidCidFormat`), blank->"-" coercion
 *    (`coerceBlank`), the UTC-today default (`todayAsDdMmYyyy` — matches the
 *    Oorwin sync engine's own Upload Date default; the known UTC-vs-IST gap
 *    is a pre-existing, tracked issue, not something this feature should
 *    quietly diverge on), and the review-flag / change-row writers
 *    (`writeReviewFlag`, `writeChange`) all come from candidate-sync-engine.ts.
 *  - The JR ID Scan/save-time conflict check reuses
 *    `resolveCandidateAutoFetchFields` (candidate-auto-fetch.ts) unchanged,
 *    with every Oorwin fallback `null` — if neither table has the JR ID, a
 *    field simply stays whatever the user typed. This never overwrites a
 *    user-entered value; it only detects LATERAL-vs-EXECUTIVE conflicts
 *    worth flagging.
 *  - `getCandidateMasterRowsByCid` / `getCandidateMasterById`
 *    (read-candidate-master.ts) are the soft-delete-aware, non-throwing
 *    row lookups this module needs — the old `getCandidateMasterByCid`
 *    "throw on 2+ matches" behavior is exactly the bug migration 021 fixed
 *    in the sync engine, so it's not used here either.
 *
 * Every write here is one `candidate_sync_history` row (`kind` =
 * 'manual_add' | 'manual_modify') plus 0+ `candidate_sync_changes` /
 * `candidate_review_flags` rows, inside one `sql.begin` transaction — a
 * single manual action is all-or-nothing, unlike the Oorwin sync engine's
 * per-row commit style (this only ever handles one row per call).
 */
import type postgres from "postgres";
import { getDbClient } from "@/lib/persistence/db-client";
import {
  getCandidateMasterById,
  getCandidateMasterRowsByCid,
  type CandidateMasterRow,
  type SqlClient,
} from "@/services/persistence/read-candidate-master";

/**
 * The top-level client only (needs `.begin`, which
 * `read-candidate-master.ts`'s widened `SqlClient` deliberately drops so it
 * can also accept a `tx` handle) — used for this module's own entry-point
 * `sqlClient?` params, which are always the real top-level client, never a
 * transaction handle passed in from elsewhere.
 */
type TopLevelSqlClient = ReturnType<typeof postgres>;
import {
  CANDIDATE_MASTER_SHEET_DB_COLUMNS,
  type CandidateMasterSheetDbColumn,
} from "@/services/persistence/candidate-master-sheet-columns";
import {
  coerceBlank,
  isValidCidFormat,
  todayAsDdMmYyyy,
  writeChange,
  writeReviewFlag,
} from "./candidate-sync-engine";
import { resolveCandidateAutoFetchFields } from "./candidate-auto-fetch";
import { normalizeCandidateMobile } from "./candidate-field-utils";

/** All 16 dashboard columns, keyed by their DB column name (same set/order as CANDIDATE_MASTER_SHEET_DB_COLUMNS). */
export type CandidateManualFieldValues = Record<CandidateMasterSheetDbColumn, string>;

/** Fields diffed/logged on a Modify — every column except `cid` gets its own entry; `cid` is handled separately (see `resolveManualCidChange`). */
const MODIFY_DIFF_FIELDS = CANDIDATE_MASTER_SHEET_DB_COLUMNS.filter(
  (c): c is Exclude<CandidateMasterSheetDbColumn, "cid"> => c !== "cid"
);

const DATE_DDMMYYYY_REGEX = /^\d{2}\/\d{2}\/\d{4}$/;

export interface CandidateManualValidationError {
  ok: false;
  error: string;
}

export interface CandidateManualValidationSuccess {
  ok: true;
  values: CandidateManualFieldValues;
  /** Non-blank Contact Number that didn't cleanly reduce to 10 digits — stored raw, flagged. */
  uncleanContactNumberRaw: string | null;
}

/**
 * Validates + normalizes a raw (client-submitted) field map into the 16
 * stored column values. Mirrors the sync engine's own field rules
 * (candidate-sync-engine.ts's buildDesiredFields) so a manually-entered row
 * behaves the same way an Oorwin-synced one does.
 */
export function validateCandidateManualInput(
  raw: Record<string, string>
): CandidateManualValidationError | CandidateManualValidationSuccess {
  const cidRaw = String(raw.cid ?? "").trim();
  if (!cidRaw) return { ok: false, error: "Candidate ID is required." };
  if (!isValidCidFormat(cidRaw)) {
    return { ok: false, error: 'Candidate ID must be "C" followed by digits, e.g. C12345.' };
  }

  const nameRaw = String(raw.name ?? "").trim();
  if (!nameRaw) return { ok: false, error: "Name is required." };

  for (const [field, label] of [
    ["date_of_upload", "Upload Date"],
    ["submitted_date", "Submitted Date"],
  ] as const) {
    const value = String(raw[field] ?? "").trim();
    if (value !== "" && value !== "-" && !DATE_DDMMYYYY_REGEX.test(value)) {
      return { ok: false, error: `${label} must be in DD/MM/YYYY format, or left blank.` };
    }
  }

  const mobileRaw = String(raw.contact_number ?? "").trim();
  const mobile = normalizeCandidateMobile(mobileRaw);
  const contactNumber = mobile.ok && mobile.normalized ? mobile.normalized : coerceBlank(mobileRaw);
  const uncleanContactNumberRaw =
    !mobile.ok && mobileRaw !== "" && mobileRaw !== "-" ? mobileRaw : null;

  const dateOfUpload = coerceBlank(String(raw.date_of_upload ?? ""));

  const values: CandidateManualFieldValues = {
    cid: cidRaw,
    date_of_upload: dateOfUpload === "-" ? todayAsDdMmYyyy() : dateOfUpload,
    name: nameRaw,
    email: coerceBlank(String(raw.email ?? "")),
    contact_number: contactNumber,
    submitter: coerceBlank(String(raw.submitter ?? "")),
    customer: coerceBlank(String(raw.customer ?? "")),
    job_requisition_id: coerceBlank(String(raw.job_requisition_id ?? "")),
    primary_skills: coerceBlank(String(raw.primary_skills ?? "")),
    job_management_level: coerceBlank(String(raw.job_management_level ?? "")),
    market: coerceBlank(String(raw.market ?? "")),
    client_spoc: coerceBlank(String(raw.client_spoc ?? "")),
    status: coerceBlank(String(raw.status ?? "")),
    submitted_date: coerceBlank(String(raw.submitted_date ?? "")),
    submission_comments: coerceBlank(String(raw.submission_comments ?? "")),
    gender: coerceBlank(String(raw.gender ?? "")),
  };

  return { ok: true, values, uncleanContactNumberRaw };
}

/** Live rows currently sharing one CID — the Add duplicate-check (GET /rows?cid=, and POST /rows's own 409 path). */
export async function findLiveCandidateRowsByCid(
  cid: string,
  sqlClient?: SqlClient
): Promise<CandidateMasterRow[]> {
  return getCandidateMasterRowsByCid(cid, sqlClient);
}

/**
 * Add's duplicate option (b), "treat as existing" (confirmed shape): merge
 * the ENTERED raw values onto the chosen existing row — a field the user
 * left blank keeps that row's current value; a field the user did fill in
 * overwrites it. Must run on the pre-coerceBlank raw strings (a "-" the
 * user actually typed is a deliberate value, not "left blank").
 */
export function mergeManualValuesOntoExistingRow(
  raw: Record<string, string>,
  existing: CandidateMasterRow
): Record<string, string> {
  const merged: Record<string, string> = { ...raw };
  for (const field of CANDIDATE_MASTER_SHEET_DB_COLUMNS) {
    const entered = String(raw[field] ?? "").trim();
    if (entered === "") {
      merged[field] = (existing as unknown as Record<string, string>)[field] ?? "-";
    }
  }
  // CID is never merged from the existing row — this IS how the user is
  // choosing which existing row to update; the row's own real cid stays cid.
  merged.cid = existing.cid;
  return merged;
}

/**
 * Deliberately takes the TOP-LEVEL client, never a `tx` — it's a read-only
 * check run BEFORE the write transaction opens (see both call sites below),
 * because resolveCandidateAutoFetchFields ultimately calls into
 * read-lateral-master.ts / read-executive-master.ts, whose own `SqlClient`
 * types are unwidened (plain `Sql<{}>`, no `TransactionSql` — out of scope
 * for this feature to touch) and would reject a transaction handle anyway.
 */
async function runJrConflictCheck(
  sqlClient: TopLevelSqlClient,
  jobRequisitionId: string
): Promise<
  { field: "primary_skills" | "job_management_level" | "market" | "client_spoc"; lateralValue: string; executiveValue: string }[]
> {
  if (!jobRequisitionId || jobRequisitionId === "-") return [];
  const autoFetch = await resolveCandidateAutoFetchFields(
    jobRequisitionId,
    { primarySkills: null, market: null, clientSpoc: null },
    sqlClient
  );
  return autoFetch.conflicts.map((c) => ({
    field:
      c.field === "primarySkills"
        ? "primary_skills"
        : c.field === "jobManagementLevel"
          ? "job_management_level"
          : c.field === "market"
            ? "market"
            : "client_spoc",
    lateralValue: c.lateralValue,
    executiveValue: c.executiveValue,
  }));
}

export interface CandidateManualAddResult {
  row: CandidateMasterRow;
  historyId: number;
  flagsWritten: number;
}

/** Plain insert — Add itself, or the "add anyway" (a) branch of a duplicate CID. */
export async function insertCandidateManualRow(
  values: CandidateManualFieldValues,
  uncleanContactNumberRaw: string | null,
  actor: string,
  sqlClient?: TopLevelSqlClient
): Promise<CandidateManualAddResult> {
  const outerSql = sqlClient ?? getDbClient();
  // Read-only, run before the write transaction opens — see runJrConflictCheck's doc comment.
  const jrConflicts = await runJrConflictCheck(outerSql, values.job_requisition_id);
  return outerSql.begin(async (tx) => {
    const startedAt = new Date();
    const [historyRow] = await tx<{ id: number }[]>`
      INSERT INTO candidate_sync_history
        (started_at, finished_at, result, source_filename, triggered_by, kind, rows_in_sheet, inserted_count)
      VALUES (${startedAt}, ${startedAt}, 'success', 'manual-add', ${actor}, 'manual_add', 1, 1)
      RETURNING id
    `;
    const syncId = Number(historyRow.id);

    const [inserted] = await tx<{ id: number }[]>`
      INSERT INTO candidate_master (
        cid, name, gender, contact_number, date_of_upload, submitter, customer,
        job_requisition_id, primary_skills, job_management_level, market,
        client_spoc, status, submitted_date, submission_comments, email,
        last_touched_at, inserted_sync_id
      ) VALUES (
        ${values.cid}, ${values.name}, ${values.gender}, ${values.contact_number},
        ${values.date_of_upload}, ${values.submitter}, ${values.customer},
        ${values.job_requisition_id}, ${values.primary_skills}, ${values.job_management_level},
        ${values.market}, ${values.client_spoc}, ${values.status}, ${values.submitted_date},
        ${values.submission_comments}, ${values.email}, NOW(), ${syncId}
      )
      RETURNING id
    `;
    const candidateMasterId = Number(inserted.id);

    let flagsWritten = 0;
    for (const field of CANDIDATE_MASTER_SHEET_DB_COLUMNS) {
      const value = values[field];
      if (value === "-" || value === "") continue;
      await writeChange(tx, syncId, values.cid, field, null, value, candidateMasterId);
    }

    if (uncleanContactNumberRaw !== null) {
      await writeReviewFlag(tx, syncId, values.cid, "unclean_contact_number", {
        raw: uncleanContactNumberRaw,
        manual: true,
      });
      flagsWritten += 1;
    }
    if (values.job_requisition_id === "-") {
      await writeReviewFlag(tx, syncId, values.cid, "missing_job_requisition_id", { manual: true });
      flagsWritten += 1;
    }
    for (const conflict of jrConflicts) {
      await writeReviewFlag(tx, syncId, values.cid, "jr_id_conflict", { ...conflict, manual: true });
      flagsWritten += 1;
    }

    if (flagsWritten > 0) {
      await tx`
        UPDATE candidate_sync_history SET result = 'partial', review_flag_count = ${flagsWritten}
        WHERE id = ${syncId}
      `;
    }

    const row = await getCandidateMasterById(candidateMasterId, tx);
    if (!row) throw new Error("[candidate-manual-edit] Row vanished immediately after insert.");
    return { row, historyId: syncId, flagsWritten };
  });
}

export interface CandidateManualModifyResult {
  row: CandidateMasterRow;
  historyId: number | null;
  flagsWritten: number;
  changedFields: CandidateMasterSheetDbColumn[];
}

export type CandidateManualModifyOutcome =
  | { status: "ok"; result: CandidateManualModifyResult }
  | { status: "not_found" }
  | { status: "stale"; current: CandidateMasterRow }
  | { status: "no_change" }
  | { status: "invalid"; error: string };

/**
 * Modify: diffs `values` against the row's CURRENT stored state (re-read
 * live, never trusted from the client) and writes only what actually
 * changed. `original` is the 16-field snapshot the client loaded when it
 * opened the modal — if the live row no longer matches it, something else
 * (an Upload, another Modify) landed in between and this call is rejected
 * as stale rather than silently clobbering it.
 */
export async function updateCandidateManualRow(
  id: number,
  values: CandidateManualFieldValues,
  uncleanContactNumberRaw: string | null,
  original: CandidateManualFieldValues | null,
  actor: string,
  sqlClient?: TopLevelSqlClient
): Promise<CandidateManualModifyOutcome> {
  const outerSql = sqlClient ?? getDbClient();
  const current = await getCandidateMasterById(id, outerSql);
  if (!current) return { status: "not_found" };

  if (original) {
    for (const field of CANDIDATE_MASTER_SHEET_DB_COLUMNS) {
      if (original[field] !== (current as unknown as Record<string, string>)[field]) {
        return { status: "stale", current };
      }
    }
  }

  if (values.cid !== current.cid && !isValidCidFormat(values.cid)) {
    return { status: "invalid", error: 'Candidate ID must be "C" followed by digits, e.g. C12345.' };
  }

  const cidChanged = values.cid !== current.cid;
  const changedFields: CandidateMasterSheetDbColumn[] = [];
  for (const field of MODIFY_DIFF_FIELDS) {
    if (values[field] !== (current as unknown as Record<string, string>)[field]) {
      changedFields.push(field);
    }
  }
  if (cidChanged) changedFields.push("cid");

  if (changedFields.length === 0) return { status: "no_change" };

  // Every subsequent change row is filed under the row's FINAL cid (after
  // this update), per the confirmed rule: a CID rename is logged "under the
  // new CID" — and it would be inconsistent for the other fields changed in
  // the SAME action to be filed under the old one.
  const finalCid = values.cid;

  // Read-only, run before the write transaction opens — see runJrConflictCheck's doc comment.
  const jrConflicts = changedFields.includes("job_requisition_id")
    ? await runJrConflictCheck(outerSql, values.job_requisition_id)
    : [];

  const outcome = await outerSql.begin(async (tx) => {
    const startedAt = new Date();
    const [historyRow] = await tx<{ id: number }[]>`
      INSERT INTO candidate_sync_history
        (started_at, finished_at, result, source_filename, triggered_by, kind, rows_in_sheet, updated_count)
      VALUES (${startedAt}, ${startedAt}, 'success', 'manual-modify', ${actor}, 'manual_modify', 1, 1)
      RETURNING id
    `;
    const syncId = Number(historyRow.id);

    for (const field of changedFields) {
      const oldValue =
        field === "cid" ? current.cid : (current as unknown as Record<string, string>)[field];
      await writeChange(tx, syncId, finalCid, field, oldValue, values[field], id);
    }

    let flagsWritten = 0;
    if (changedFields.includes("contact_number") && uncleanContactNumberRaw !== null) {
      await writeReviewFlag(tx, syncId, finalCid, "unclean_contact_number", {
        raw: uncleanContactNumberRaw,
        manual: true,
      });
      flagsWritten += 1;
    }
    if (changedFields.includes("job_requisition_id") && values.job_requisition_id === "-") {
      await writeReviewFlag(tx, syncId, finalCid, "missing_job_requisition_id", { manual: true });
      flagsWritten += 1;
    }
    for (const conflict of jrConflicts) {
      await writeReviewFlag(tx, syncId, finalCid, "jr_id_conflict", { ...conflict, manual: true });
      flagsWritten += 1;
    }

    // Every column set unconditionally (changed values, or the row's own
    // current value for anything unchanged) — same "static full SET list"
    // convention candidate-sync-engine.ts's UPDATE already uses.
    await tx`
      UPDATE candidate_master SET
        cid = ${values.cid},
        name = ${values.name},
        gender = ${values.gender},
        contact_number = ${values.contact_number},
        date_of_upload = ${values.date_of_upload},
        submitter = ${values.submitter},
        customer = ${values.customer},
        job_requisition_id = ${values.job_requisition_id},
        primary_skills = ${values.primary_skills},
        job_management_level = ${values.job_management_level},
        market = ${values.market},
        client_spoc = ${values.client_spoc},
        status = ${values.status},
        submitted_date = ${values.submitted_date},
        submission_comments = ${values.submission_comments},
        email = ${values.email},
        last_touched_at = NOW(),
        updated_at = NOW()
      WHERE id = ${id} AND deleted_at IS NULL
    `;

    if (flagsWritten > 0) {
      await tx`
        UPDATE candidate_sync_history SET result = 'partial', review_flag_count = ${flagsWritten}
        WHERE id = ${syncId}
      `;
    }

    const row = await getCandidateMasterById(id, tx);
    if (!row) throw new Error("[candidate-manual-edit] Row vanished immediately after update.");
    return { row, historyId: syncId, flagsWritten, changedFields };
  });

  return { status: "ok", result: outcome };
}

export interface CandidateManualDeleteResult {
  id: number;
  cid: string;
  name: string;
}

/** Soft delete — no history/change row (see the plan's audit-trail note: deleted_at/deleted_by + the purge job's log line is the trail). */
export async function softDeleteCandidateManualRow(
  id: number,
  actor: string,
  sqlClient?: SqlClient
): Promise<CandidateManualDeleteResult | null> {
  const sql = sqlClient ?? getDbClient();
  const rows = await sql<{ id: number; cid: string; name: string }[]>`
    UPDATE candidate_master
    SET deleted_at = NOW(), deleted_by = ${actor}
    WHERE id = ${id} AND deleted_at IS NULL
    RETURNING id, cid, name
  `;
  const row = rows[0];
  if (!row) return null;
  return { id: Number(row.id), cid: row.cid, name: row.name };
}
