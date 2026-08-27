/**
 * Phase 4A — lateral_staging → lateral_master field UPSERT.
 *
 * Key: job_requisition_id (PRIMARY KEY)
 * Updates business fields from staging only.
 * Does NOT change job_status, posted, or created_at on existing rows.
 * Does NOT delete Master rows.
 * Does NOT implement Phase 4B Job Status rules.
 *
 * Empty/NULL policy (established Phase 3 / backfill):
 *   normalizeOptionalText → empty string → NULL.
 *   Staging already stores NULL for empty optionals.
 *   Field UPSERT writes staging values as-is (NULL clears the Master field).
 *
 * New-row defaults:
 *   job_status = NULL, posted = NULL (schema allows NULL; no invented status).
 */

import type postgres from "postgres";
import { acquireLateralJobLockOn } from "@/lib/persistence/job-lock";
import {
  formatLateralPgDateDdMmYyyy,
  formatLateralPgTimestampIst,
  normalizeOptionalText,
} from "@/services/lateral-processing/lateral-master-pg-backfill";

export type SqlClient = ReturnType<typeof postgres>;

/** Business fields synced from staging (excludes JR key + Master-only columns). */
export const LATERAL_MASTER_UPSERT_FIELDS = [
  "date",
  "priority",
  "job_description",
  "skill_categorization",
  "primary_skills",
  "job_management_level",
  "primary_location",
  "market_map",
  "poc",
] as const;

export type LateralMasterUpsertField =
  (typeof LATERAL_MASTER_UPSERT_FIELDS)[number];

export interface StagingSourceRow {
  date: string | null; // YYYY-MM-DD
  job_requisition_id: string;
  priority: string | null;
  job_description: string | null;
  skill_categorization: string | null;
  primary_skills: string | null;
  job_management_level: string | null;
  primary_location: string | null;
  market_map: string | null;
  poc: string | null;
}

export interface MasterExistingRow {
  job_requisition_id: string;
  date: string | null;
  priority: string | null;
  job_description: string | null;
  skill_categorization: string | null;
  primary_skills: string | null;
  job_management_level: string | null;
  primary_location: string | null;
  market_map: string | null;
  poc: string | null;
  job_status: string | null;
  posted: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  last_seen_at: Date | string | null;
}

export interface StagingValidationFailure {
  ok: false;
  message: string;
  stagingCount: number;
  missingJrCount: number;
  duplicateJrCount: number;
  invalidDateCount: number;
  duplicateJrs: string[];
  invalidDates: Array<{ job_requisition_id: string; value: string }>;
}

export interface StagingValidationSuccess {
  ok: true;
  rows: StagingSourceRow[];
  stagingCount: number;
}

export type StagingForMasterValidationResult =
  | StagingValidationSuccess
  | StagingValidationFailure;

export interface LateralMasterUpsertCounts {
  masterBefore: number;
  stagingBefore: number;
  newJrCount: number;
  existingJrCount: number;
  inserted: number;
  updated: number;
  unchanged: number;
  failed: number;
  deleted: number;
  masterAfter: number | null;
  stagingAfter: number | null;
  duplicateJrCount: number;
}

export interface LateralMasterUpsertReport {
  status: "success" | "aborted" | "failed" | "busy";
  message: string;
  dryRun: boolean;
  ranAtDisplay: string;
  syncTimestampIso: string;
  syncTimestampDisplay: string;
  counts: LateralMasterUpsertCounts;
  sampleNewJrs: string[];
  sampleUpdatedJrs: string[];
  sampleUnchangedJrs: string[];
  preservation: {
    createdAtPreserved: boolean | null;
    jobStatusPreserved: boolean | null;
    postedPreserved: boolean | null;
    lastSeenAtUpdatedForStaging: boolean | null;
    lastSeenAtUnchangedForAbsent: boolean | null;
  };
  emptyValuePolicy: string;
  locking: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateToIsoString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (!text) return null;
  if (ISO_DATE_RE.test(text)) return text;
  // postgres.js may return Date-like strings
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime()) && text.includes("T")) {
    return parsed.toISOString().slice(0, 10);
  }
  // DATE columns often come as YYYY-MM-DD already
  const m = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : text;
}

function normText(value: unknown): string | null {
  return normalizeOptionalText(value);
}

function fieldsEqual(
  a: StagingSourceRow,
  b: Pick<
    MasterExistingRow,
    | "date"
    | "priority"
    | "job_description"
    | "skill_categorization"
    | "primary_skills"
    | "job_management_level"
    | "primary_location"
    | "market_map"
    | "poc"
  >
): boolean {
  return (
    dateToIsoString(a.date) === dateToIsoString(b.date) &&
    normText(a.priority) === normText(b.priority) &&
    normText(a.job_description) === normText(b.job_description) &&
    normText(a.skill_categorization) === normText(b.skill_categorization) &&
    normText(a.primary_skills) === normText(b.primary_skills) &&
    normText(a.job_management_level) === normText(b.job_management_level) &&
    normText(a.primary_location) === normText(b.primary_location) &&
    normText(a.market_map) === normText(b.market_map) &&
    normText(a.poc) === normText(b.poc)
  );
}

function emptyCounts(
  partial: Partial<LateralMasterUpsertCounts> = {}
): LateralMasterUpsertCounts {
  return {
    masterBefore: partial.masterBefore ?? 0,
    stagingBefore: partial.stagingBefore ?? 0,
    newJrCount: partial.newJrCount ?? 0,
    existingJrCount: partial.existingJrCount ?? 0,
    inserted: partial.inserted ?? 0,
    updated: partial.updated ?? 0,
    unchanged: partial.unchanged ?? 0,
    failed: partial.failed ?? 0,
    deleted: 0,
    masterAfter: partial.masterAfter ?? null,
    stagingAfter: partial.stagingAfter ?? null,
    duplicateJrCount: partial.duplicateJrCount ?? 0,
  };
}

function baseReport(
  partial: Partial<LateralMasterUpsertReport> &
    Pick<LateralMasterUpsertReport, "status" | "message" | "dryRun">
): LateralMasterUpsertReport {
  const now = new Date();
  return {
    status: partial.status,
    message: partial.message,
    dryRun: partial.dryRun,
    ranAtDisplay: formatLateralPgTimestampIst(now),
    syncTimestampIso: partial.syncTimestampIso ?? now.toISOString(),
    syncTimestampDisplay:
      partial.syncTimestampDisplay ?? formatLateralPgTimestampIst(now),
    counts: partial.counts ?? emptyCounts(),
    sampleNewJrs: partial.sampleNewJrs ?? [],
    sampleUpdatedJrs: partial.sampleUpdatedJrs ?? [],
    sampleUnchangedJrs: partial.sampleUnchangedJrs ?? [],
    preservation: partial.preservation ?? {
      createdAtPreserved: null,
      jobStatusPreserved: null,
      postedPreserved: null,
      lastSeenAtUpdatedForStaging: null,
      lastSeenAtUnchangedForAbsent: null,
    },
    emptyValuePolicy:
      partial.emptyValuePolicy ??
      "Phase 3 normalizeOptionalText: empty → NULL; staging values written as field UPSERT source of truth.",
    locking:
      partial.locking ??
      "Shared Lateral pg_try_advisory_lock (key 7482910234) on the sync connection.",
  };
}

/**
 * Validate current lateral_staging for Master UPSERT.
 * Does not modify any table.
 */
export async function validateStagingForMasterUpsert(
  sql: SqlClient
): Promise<StagingForMasterValidationResult> {
  const raw = await sql<
    {
      date: string | Date | null;
      job_requisition_id: string | null;
      priority: string | null;
      job_description: string | null;
      skill_categorization: string | null;
      primary_skills: string | null;
      job_management_level: string | null;
      primary_location: string | null;
      market_map: string | null;
      poc: string | null;
    }[]
  >`
    SELECT
      date,
      job_requisition_id,
      priority,
      job_description,
      skill_categorization,
      primary_skills,
      job_management_level,
      primary_location,
      market_map,
      poc
    FROM lateral_staging
    ORDER BY id ASC
  `;

  const stagingCount = raw.length;
  if (stagingCount === 0) {
    return {
      ok: false,
      message: "lateral_staging is empty — nothing to UPSERT into Master.",
      stagingCount: 0,
      missingJrCount: 0,
      duplicateJrCount: 0,
      invalidDateCount: 0,
      duplicateJrs: [],
      invalidDates: [],
    };
  }

  const missingJrCount = raw.filter(
    (r) => !String(r.job_requisition_id ?? "").trim()
  ).length;

  const jrCounts = new Map<string, number>();
  for (const r of raw) {
    const jr = String(r.job_requisition_id ?? "").trim();
    if (!jr) continue;
    jrCounts.set(jr, (jrCounts.get(jr) ?? 0) + 1);
  }
  const duplicateJrs = [...jrCounts.entries()]
    .filter(([, n]) => n > 1)
    .map(([jr]) => jr);
  const duplicateJrCount = duplicateJrs.length;

  const invalidDates: Array<{ job_requisition_id: string; value: string }> = [];
  const rows: StagingSourceRow[] = [];

  for (const r of raw) {
    const jr = String(r.job_requisition_id ?? "").trim();
    if (!jr) continue;

    const dateIso = dateToIsoString(r.date);
    if (r.date != null && dateIso == null) {
      invalidDates.push({
        job_requisition_id: jr,
        value: String(r.date),
      });
      continue;
    }
    if (dateIso != null && !ISO_DATE_RE.test(dateIso)) {
      invalidDates.push({
        job_requisition_id: jr,
        value: dateIso,
      });
      continue;
    }

    rows.push({
      date: dateIso,
      job_requisition_id: jr,
      priority: normText(r.priority),
      job_description: normText(r.job_description),
      skill_categorization: normText(r.skill_categorization),
      primary_skills: normText(r.primary_skills),
      job_management_level: normText(r.job_management_level),
      primary_location: normText(r.primary_location),
      market_map: normText(r.market_map),
      poc: normText(r.poc),
    });
  }

  if (
    missingJrCount > 0 ||
    duplicateJrCount > 0 ||
    invalidDates.length > 0 ||
    rows.length === 0
  ) {
    return {
      ok: false,
      message: [
        missingJrCount > 0 ? `${missingJrCount} row(s) missing job_requisition_id` : null,
        duplicateJrCount > 0
          ? `${duplicateJrCount} duplicate JR(s) in staging`
          : null,
        invalidDates.length > 0
          ? `${invalidDates.length} invalid date(s)`
          : null,
        rows.length === 0 ? "no valid staging rows" : null,
      ]
        .filter(Boolean)
        .join("; "),
      stagingCount,
      missingJrCount,
      duplicateJrCount,
      invalidDateCount: invalidDates.length,
      duplicateJrs: duplicateJrs.slice(0, 20),
      invalidDates: invalidDates.slice(0, 20),
    };
  }

  return { ok: true, rows, stagingCount };
}

async function countTable(
  sql: SqlClient,
  table: "lateral_master" | "lateral_staging"
): Promise<number> {
  if (table === "lateral_master") {
    const rows = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM lateral_master
    `;
    return Number(rows[0]?.c ?? 0);
  }
  const rows = await sql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM lateral_staging
  `;
  return Number(rows[0]?.c ?? 0);
}

/**
 * Classify staging rows against Master without writing.
 */
export async function classifyStagingAgainstMaster(
  sql: SqlClient,
  stagingRows: StagingSourceRow[]
): Promise<{
  newRows: StagingSourceRow[];
  updatedRows: StagingSourceRow[];
  unchangedRows: StagingSourceRow[];
  existingByJr: Map<string, MasterExistingRow>;
}> {
  const jrs = stagingRows.map((r) => r.job_requisition_id);
  const existing = await sql<MasterExistingRow[]>`
    SELECT
      job_requisition_id,
      date::text AS date,
      priority,
      job_description,
      skill_categorization,
      primary_skills,
      job_management_level,
      primary_location,
      market_map,
      poc,
      job_status,
      posted,
      created_at,
      updated_at,
      last_seen_at
    FROM lateral_master
    WHERE job_requisition_id IN ${sql(jrs)}
  `;

  const existingByJr = new Map<string, MasterExistingRow>();
  for (const row of existing) {
    existingByJr.set(row.job_requisition_id, {
      ...row,
      date: dateToIsoString(row.date),
    });
  }

  const newRows: StagingSourceRow[] = [];
  const updatedRows: StagingSourceRow[] = [];
  const unchangedRows: StagingSourceRow[] = [];

  for (const s of stagingRows) {
    const m = existingByJr.get(s.job_requisition_id);
    if (!m) {
      newRows.push(s);
      continue;
    }
    if (fieldsEqual(s, m)) {
      unchangedRows.push(s);
    } else {
      updatedRows.push(s);
    }
  }

  return { newRows, updatedRows, unchangedRows, existingByJr };
}

/**
 * Apply UPSERT inside an existing transaction client.
 *
 * Uses INSERT … ON CONFLICT DO UPDATE so the PK prevents duplicates.
 * Always sets updated_at + last_seen_at for every staging JR (including unchanged fields).
 * Never touches job_status, posted, or created_at on conflict.
 *
 * `expectedInserted` / `expectedUpdated` come from pre-classification (new vs existing).
 */
export async function upsertStagingRowsIntoMaster(
  tx: SqlClient,
  stagingRows: StagingSourceRow[],
  syncAt: Date,
  expected?: { inserted: number; updated: number }
): Promise<{ inserted: number; updated: number }> {
  const syncIso = syncAt.toISOString();
  const BATCH = 250;

  for (let i = 0; i < stagingRows.length; i += BATCH) {
    const chunk = stagingRows.slice(i, i + BATCH);
    const values = chunk.map((row) => [
      row.job_requisition_id,
      row.date,
      row.priority,
      row.job_description,
      row.skill_categorization,
      row.primary_skills,
      row.job_management_level,
      row.primary_location,
      row.market_map,
      row.poc,
      syncIso,
      syncIso,
      syncIso,
    ]);

    await tx`
      INSERT INTO lateral_master (
        job_requisition_id,
        date,
        priority,
        job_description,
        skill_categorization,
        primary_skills,
        job_management_level,
        primary_location,
        market_map,
        poc,
        created_at,
        updated_at,
        last_seen_at
      )
      SELECT
        v.job_requisition_id,
        v.date::date,
        v.priority,
        v.job_description,
        v.skill_categorization,
        v.primary_skills,
        v.job_management_level,
        v.primary_location,
        v.market_map,
        v.poc,
        v.created_at::timestamptz,
        v.updated_at::timestamptz,
        v.last_seen_at::timestamptz
      FROM (VALUES ${tx(values as never)}) AS v(
        job_requisition_id,
        date,
        priority,
        job_description,
        skill_categorization,
        primary_skills,
        job_management_level,
        primary_location,
        market_map,
        poc,
        created_at,
        updated_at,
        last_seen_at
      )
      ON CONFLICT (job_requisition_id) DO UPDATE SET
        date = EXCLUDED.date,
        priority = EXCLUDED.priority,
        job_description = EXCLUDED.job_description,
        skill_categorization = EXCLUDED.skill_categorization,
        primary_skills = EXCLUDED.primary_skills,
        job_management_level = EXCLUDED.job_management_level,
        primary_location = EXCLUDED.primary_location,
        market_map = EXCLUDED.market_map,
        poc = EXCLUDED.poc,
        updated_at = EXCLUDED.updated_at,
        last_seen_at = EXCLUDED.last_seen_at
    `;
  }

  return {
    inserted: expected?.inserted ?? 0,
    updated: expected?.updated ?? stagingRows.length,
  };
}

/**
 * Force a mid-transaction failure for rollback tests.
 * Only used by tests — not exposed via CLI.
 */
export async function upsertStagingRowsIntoMasterThenFail(
  tx: SqlClient,
  stagingRows: StagingSourceRow[],
  syncAt: Date
): Promise<never> {
  await upsertStagingRowsIntoMaster(tx, stagingRows, syncAt);
  throw new Error("simulated Phase 4A Master UPSERT failure");
}

async function verifyPreservationSamples(
  sql: SqlClient,
  existingByJr: Map<string, MasterExistingRow>,
  processedJrs: string[],
  absentJr: string | null,
  syncAt: Date
): Promise<LateralMasterUpsertReport["preservation"]> {
  const sampleExisting = processedJrs
    .filter((jr) => existingByJr.has(jr))
    .slice(0, 25);

  if (sampleExisting.length === 0 && !absentJr) {
    return {
      createdAtPreserved: null,
      jobStatusPreserved: null,
      postedPreserved: null,
      lastSeenAtUpdatedForStaging: processedJrs.length === 0 ? null : true,
      lastSeenAtUnchangedForAbsent: null,
    };
  }

  let createdAtPreserved = true;
  let jobStatusPreserved = true;
  let postedPreserved = true;
  let lastSeenAtUpdatedForStaging = true;

  if (sampleExisting.length > 0) {
    const after = await sql<MasterExistingRow[]>`
      SELECT
        job_requisition_id,
        date::text AS date,
        priority,
        job_description,
        skill_categorization,
        primary_skills,
        job_management_level,
        primary_location,
        market_map,
        poc,
        job_status,
        posted,
        created_at,
        updated_at,
        last_seen_at
      FROM lateral_master
      WHERE job_requisition_id IN ${sql(sampleExisting)}
    `;

    const afterByJr = new Map(after.map((r) => [r.job_requisition_id, r]));
    const syncMs = syncAt.getTime();

    for (const jr of sampleExisting) {
      const before = existingByJr.get(jr)!;
      const a = afterByJr.get(jr);
      if (!a) {
        createdAtPreserved = false;
        jobStatusPreserved = false;
        postedPreserved = false;
        lastSeenAtUpdatedForStaging = false;
        continue;
      }
      const beforeCreated = new Date(before.created_at).getTime();
      const afterCreated = new Date(a.created_at).getTime();
      if (beforeCreated !== afterCreated) createdAtPreserved = false;
      if ((before.job_status ?? null) !== (a.job_status ?? null)) {
        jobStatusPreserved = false;
      }
      if ((before.posted ?? null) !== (a.posted ?? null)) {
        postedPreserved = false;
      }
      if (!a.last_seen_at) {
        lastSeenAtUpdatedForStaging = false;
      } else {
        const seenMs = new Date(a.last_seen_at).getTime();
        if (Math.abs(seenMs - syncMs) > 60_000) {
          lastSeenAtUpdatedForStaging = false;
        }
      }
    }
  }

  let lastSeenAtUnchangedForAbsent: boolean | null = null;
  if (absentJr && existingByJr.has(absentJr) === false) {
    // absent JR was loaded separately by caller into map under special handling
  }
  if (absentJr) {
    const beforeRows = await sql<
      { last_seen_at: Date | string | null }[]
    >`SELECT last_seen_at FROM lateral_master WHERE job_requisition_id = ${absentJr} LIMIT 1`;
    // Caller should pass pre-sync last_seen via existingByJr using a sentinel —
    // for live report we compare only if we stored it.
    const stored = existingByJr.get(absentJr);
    if (stored && beforeRows[0]) {
      const beforeMs = stored.last_seen_at
        ? new Date(stored.last_seen_at).getTime()
        : null;
      const afterMs = beforeRows[0].last_seen_at
        ? new Date(beforeRows[0].last_seen_at).getTime()
        : null;
      lastSeenAtUnchangedForAbsent = beforeMs === afterMs;
    }
  }

  return {
    createdAtPreserved: sampleExisting.length ? createdAtPreserved : null,
    jobStatusPreserved: sampleExisting.length ? jobStatusPreserved : null,
    postedPreserved: sampleExisting.length ? postedPreserved : null,
    lastSeenAtUpdatedForStaging,
    lastSeenAtUnchangedForAbsent,
  };
}

export interface SyncLateralMasterFromStagingOptions {
  sql: SqlClient;
  dryRun?: boolean;
  /** Skip advisory lock (tests that already hold isolation). Default false. */
  skipLock?: boolean;
  /** Test-only: after applying upserts, throw before commit. */
  forceFailureAfterUpsert?: boolean;
}

/**
 * Phase 4A entry point: validate staging → UPSERT Master (transactional).
 */
export async function syncLateralMasterFromStaging(
  options: SyncLateralMasterFromStagingOptions
): Promise<LateralMasterUpsertReport> {
  const { sql, dryRun = false, skipLock = false, forceFailureAfterUpsert = false } =
    options;
  const syncAt = new Date();
  const syncIso = syncAt.toISOString();

  let lock: Awaited<ReturnType<typeof acquireLateralJobLockOn>> | null = null;
  if (!skipLock) {
    lock = await acquireLateralJobLockOn(sql);
    if (!lock.acquired) {
      return baseReport({
        status: "busy",
        message: lock.message,
        dryRun,
        syncTimestampIso: syncIso,
        counts: emptyCounts(),
      });
    }
  }

  try {
    const masterBefore = await countTable(sql, "lateral_master");
    const stagingBefore = await countTable(sql, "lateral_staging");

    const validated = await validateStagingForMasterUpsert(sql);
    if (!validated.ok) {
      return baseReport({
        status: "aborted",
        message: `Validation failed: ${validated.message}`,
        dryRun,
        syncTimestampIso: syncIso,
        counts: emptyCounts({
          masterBefore,
          stagingBefore,
          duplicateJrCount: validated.duplicateJrCount,
          masterAfter: masterBefore,
          stagingAfter: stagingBefore,
        }),
      });
    }

    const classified = await classifyStagingAgainstMaster(sql, validated.rows);
    const {
      newRows,
      updatedRows,
      unchangedRows,
      existingByJr,
    } = classified;

    // Capture one Master JR absent from staging for last_seen_at check (live report).
    let absentSample: MasterExistingRow | null = null;
    const stagingJrSet = new Set(validated.rows.map((r) => r.job_requisition_id));
    const absentHit = await sql<MasterExistingRow[]>`
      SELECT
        job_requisition_id,
        date::text AS date,
        priority,
        job_description,
        skill_categorization,
        primary_skills,
        job_management_level,
        primary_location,
        market_map,
        poc,
        job_status,
        posted,
        created_at,
        updated_at,
        last_seen_at
      FROM lateral_master
      WHERE job_requisition_id NOT IN ${sql([...stagingJrSet])}
      LIMIT 1
    `;
    if (absentHit[0]) {
      absentSample = absentHit[0];
      existingByJr.set(absentSample.job_requisition_id, {
        ...absentSample,
        date: dateToIsoString(absentSample.date),
      });
    }

    if (dryRun) {
      return baseReport({
        status: "success",
        message: `Dry run: would insert ${newRows.length}, update ${updatedRows.length} (field changes), refresh timestamps on ${unchangedRows.length} unchanged JR(s). Master untouched.`,
        dryRun: true,
        syncTimestampIso: syncIso,
        counts: emptyCounts({
          masterBefore,
          stagingBefore,
          newJrCount: newRows.length,
          existingJrCount: updatedRows.length + unchangedRows.length,
          inserted: 0,
          updated: 0,
          unchanged: unchangedRows.length,
          masterAfter: masterBefore,
          stagingAfter: stagingBefore,
        }),
        sampleNewJrs: newRows.slice(0, 10).map((r) => r.job_requisition_id),
        sampleUpdatedJrs: updatedRows
          .slice(0, 10)
          .map((r) => r.job_requisition_id),
        sampleUnchangedJrs: unchangedRows
          .slice(0, 10)
          .map((r) => r.job_requisition_id),
      });
    }

    try {
      await sql.begin(async (tx) => {
        await upsertStagingRowsIntoMaster(
          tx as unknown as SqlClient,
          validated.rows,
          syncAt,
          {
            inserted: newRows.length,
            updated: updatedRows.length + unchangedRows.length,
          }
        );
        if (forceFailureAfterUpsert) {
          throw new Error("simulated Phase 4A Master UPSERT failure");
        }
      });
    } catch (err) {
      const masterAfterFail = await countTable(sql, "lateral_master");
      const stagingAfterFail = await countTable(sql, "lateral_staging");
      return baseReport({
        status: "failed",
        message: `Master UPSERT rolled back: ${
          err instanceof Error ? err.message : String(err)
        }`,
        dryRun: false,
        syncTimestampIso: syncIso,
        counts: emptyCounts({
          masterBefore,
          stagingBefore,
          newJrCount: newRows.length,
          existingJrCount: updatedRows.length + unchangedRows.length,
          failed: validated.rows.length,
          masterAfter: masterAfterFail,
          stagingAfter: stagingAfterFail,
        }),
      });
    }

    const masterAfter = await countTable(sql, "lateral_master");
    const stagingAfter = await countTable(sql, "lateral_staging");

    const processedExisting = [...updatedRows, ...unchangedRows].map(
      (r) => r.job_requisition_id
    );
    const preservation = await verifyPreservationSamples(
      sql,
      existingByJr,
      processedExisting,
      absentSample?.job_requisition_id ?? null,
      syncAt
    );

    return baseReport({
      status: "success",
      message: `UPSERT complete: inserted ${newRows.length}, updated ${
        updatedRows.length + unchangedRows.length
      } (${updatedRows.length} field-changed, ${
        unchangedRows.length
      } timestamp-refresh). Master ${masterBefore} → ${masterAfter}.`,
      dryRun: false,
      syncTimestampIso: syncIso,
      syncTimestampDisplay: formatLateralPgTimestampIst(syncAt),
      counts: emptyCounts({
        masterBefore,
        stagingBefore,
        newJrCount: newRows.length,
        existingJrCount: updatedRows.length + unchangedRows.length,
        inserted: newRows.length,
        updated: updatedRows.length + unchangedRows.length,
        unchanged: unchangedRows.length,
        masterAfter,
        stagingAfter,
      }),
      sampleNewJrs: newRows.slice(0, 10).map((r) => r.job_requisition_id),
      sampleUpdatedJrs: updatedRows.slice(0, 10).map((r) => r.job_requisition_id),
      sampleUnchangedJrs: unchangedRows
        .slice(0, 10)
        .map((r) => r.job_requisition_id),
      preservation,
    });
  } finally {
    if (lock) await lock.release();
  }
}

export function printLateralMasterUpsertReport(
  report: LateralMasterUpsertReport
): void {
  const c = report.counts;
  const lines = [
    "",
    "========== PHASE 4A — STAGING → MASTER UPSERT ==========",
    `Status: ${report.status}`,
    `Dry run: ${report.dryRun}`,
    `Message: ${report.message}`,
    `Ran at: ${report.ranAtDisplay}`,
    `Sync timestamp: ${report.syncTimestampDisplay}`,
    "",
    "-- Counts --",
    `Master before: ${c.masterBefore}`,
    `Staging before: ${c.stagingBefore}`,
    `New JRs: ${c.newJrCount}`,
    `Existing JRs: ${c.existingJrCount}`,
    `Inserted: ${c.inserted}`,
    `Updated (incl. timestamp refresh): ${c.updated}`,
    `Unchanged fields: ${c.unchanged}`,
    `Failed: ${c.failed}`,
    `Deleted: ${c.deleted}`,
    `Duplicate JR count: ${c.duplicateJrCount}`,
    `Master after: ${c.masterAfter ?? "(n/a)"}`,
    `Staging after: ${c.stagingAfter ?? "(n/a)"}`,
    "",
    "-- Preservation --",
    `created_at preserved: ${report.preservation.createdAtPreserved}`,
    `job_status preserved: ${report.preservation.jobStatusPreserved}`,
    `posted preserved: ${report.preservation.postedPreserved}`,
    `last_seen_at updated (staging JRs): ${report.preservation.lastSeenAtUpdatedForStaging}`,
    `last_seen_at unchanged (absent JR sample): ${report.preservation.lastSeenAtUnchangedForAbsent}`,
    "",
    `Empty/NULL policy: ${report.emptyValuePolicy}`,
    `Locking: ${report.locking}`,
    "========================================================",
    "",
  ];
  console.log(lines.join("\n"));
}

/** Display helper re-export for CLI reports. */
export { formatLateralPgDateDdMmYyyy, formatLateralPgTimestampIst };
