/**
 * Rollback for one Accenture upload run (classic OR replay mode), keyed by
 * its single `candidate_sync_history.id`.
 *
 * Scope, stated explicitly: this derives correct pre-run state by looking
 * at every OTHER run that ever touched the same (row, field) — exactly
 * right for undoing the most recent run (or the only run) immediately
 * after noticing a problem. It does NOT attempt to handle undoing an old
 * run after later runs have already built on top of it; that scenario
 * should fall back to restoring from a fresh backup instead, per the
 * rollout plan this was built from.
 *
 * KNOWN, PRE-EXISTING LIMITATION (not introduced here, not fixable by
 * rollback alone): `job_management_level`'s history is logged by NUMBER
 * (both candidate-accenture-engine.ts and candidate-accenture-replay-
 * engine.ts call `normalizeStoredLevel`/`extractJmlNumber` before a row's
 * CURRENT level ever becomes a step's `old_value`) — so if a row's level
 * was stored in legacy free-text form ("9-Team Lead/Consultant", not
 * "CL9") before Accenture ever touched it, and Accenture then logs a
 * REAL level change for that row, the step's `old_value` is already the
 * normalized "CL9", never the original free text. Rolling that run back
 * can only restore to what history actually recorded — "CL9" — not the
 * true original free-text string, which was never captured anywhere.
 * Measured on the real 2026-10 Master Sheet load: 361 of the file's 3,214
 * CIDs had legacy free-text level formatting, and exactly 2 of those also
 * had a genuine (non-revert) level change logged by this run — those 2
 * come back from rollback as "CL9"/"CL10" etc., not their original text.
 * Fixing this would mean logging the raw pre-change text as a second
 * field on the history row, a change to the shared level-comparison
 * design (affecting the already-shipped classic engine too), not
 * something scoped to rollback or to replay mode — flagged for the
 * person reviewing this, not silently patched around here.
 *
 * Procedure (all within one transaction when --apply):
 *   1. Restore every touched column to its EARLIEST step's old_value for
 *      this sync_id, pivoted into one row per candidate_master_id first —
 *      a naive multi-row UPDATE...FROM silently restores only one of a
 *      row's touched fields when 2+ were touched in the same run (found
 *      by rehearsing this exact bug against a hand-built fixture during
 *      planning; fixed here by the pivot).
 *   2. Recompute the sticky locks (email/level): TRUE iff some OTHER
 *      accenture_upload run ever gave a usable value for that field.
 *   3. Recompute last_accenture_sync_id: MAX(id) of OTHER accenture_upload
 *      runs that touched this row, else NULL.
 *   4. Recompute last_accenture_report_date (migration 023) from the
 *      latest OTHER run's logged changed_at for this row (any field),
 *      else NULL. NOTE: this is an approximation when multiple past runs
 *      exist and the immediately-prior one was itself a full no-op across
 *      every field for this row (the same gap migration 023 exists to
 *      close for forward replay) — exact for undoing THE ONLY run ever
 *      (this file's first real use case) and for the common "undo my
 *      last upload" case.
 *   5. Delete this run's inserted rows (inserted_sync_id = R).
 *   6. Delete this run's candidate_sync_changes rows, then its
 *      candidate_sync_history row.
 *
 * Same safety conventions as scripts/candidate-accenture-upload.ts: dry
 * run is provably read-only (`SET default_transaction_read_only = on` on
 * a dedicated max:1 connection); --apply needs --confirm-rows=<N> matching
 * the LIVE recomputed count of candidate_master rows this sync_id touched
 * (matched + inserted); --apply against a database literally named
 * "ara_db" additionally needs --allow-prod. Prints target DB host/name
 * (never the password) before anything else.
 *
 * Usage:
 *   npx tsx scripts/candidate-accenture-rollback.ts --sync-id=<R>
 *   npx tsx scripts/candidate-accenture-rollback.ts --sync-id=<R> --apply --confirm-rows=<N> [--allow-prod]
 */
import postgres from "postgres";

const PROD_DB_NAME = "ara_db";
const SYNCED_FIELDS = [
  "email",
  "job_management_level",
  "accenture_candidate_stage",
  "current_cid_source",
  "application_completion_status",
] as const;

function parseTarget(url: string): { host: string; dbName: string } {
  const afterAt = url.split("@")[1] ?? url;
  const host = afterAt.split("/")[0] ?? "(unknown)";
  const dbNameMatch = url.match(/\/([^/?]+)(\?|$)/);
  const dbName = dbNameMatch ? dbNameMatch[1] : "(unknown)";
  return { host, dbName };
}

function makeSqlClient(url: string): ReturnType<typeof postgres> {
  return postgres(url, {
    max: 1,
    connect_timeout: 15,
    prepare: false,
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });
}

interface Preview {
  historyRowCount: number;
  touchedRowCount: number;
  insertedRowCount: number;
  fieldRestoreCounts: Record<string, number>;
}

async function computePreview(sql: ReturnType<typeof postgres>, syncId: number): Promise<Preview> {
  const historyRowCount = Number(
    (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_sync_changes WHERE sync_id = ${syncId}`)[0].c
  );
  const touchedRowCount = Number(
    (await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM candidate_master
      WHERE last_accenture_sync_id = ${syncId} OR inserted_sync_id = ${syncId}
    `)[0].c
  );
  const insertedRowCount = Number(
    (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_master WHERE inserted_sync_id = ${syncId}`)[0].c
  );
  const fieldRows = await sql<{ field_name: string; c: string }[]>`
    SELECT field_name, COUNT(DISTINCT candidate_master_id)::text AS c
    FROM candidate_sync_changes WHERE sync_id = ${syncId} GROUP BY field_name
  `;
  const fieldRestoreCounts: Record<string, number> = {};
  for (const row of fieldRows) fieldRestoreCounts[row.field_name] = Number(row.c);
  return { historyRowCount, touchedRowCount, insertedRowCount, fieldRestoreCounts };
}

async function applyRollback(sql: ReturnType<typeof postgres>, syncId: number): Promise<void> {
  await sql.begin(async (tx) => {
    // A (row, field) can have REAL steps logged (e.g. a revert A->B->A)
    // while never actually writing the live column — the replay engine's
    // own wouldWriteLive is independent of whether steps exist. Restoring
    // every field that merely HAS a step for this sync_id would wrongly
    // overwrite a field the apply never touched live — found at full
    // scale: a row whose job_management_level reverted back to its
    // original number came back from rollback as the chain's NORMALIZED
    // seed form ("CL9") instead of the row's true original free-text
    // value ("9-Team Lead/Consultant") it had the entire time, because
    // the live column was never actually written in the first place.
    // The fix: only restore a field when its earliest step's old_value
    // differs from its latest step's new_value for this run — exactly
    // wouldWriteLive, derived from history with no new column needed.
    await tx`
      WITH field_steps AS (
        SELECT candidate_master_id, field_name, old_value, new_value, changed_at, id
        FROM candidate_sync_changes
        WHERE sync_id = ${syncId} AND field_name = ANY(${[...SYNCED_FIELDS]})
      ),
      earliest_steps AS (
        SELECT DISTINCT ON (candidate_master_id, field_name)
          candidate_master_id, field_name, old_value
        FROM field_steps
        ORDER BY candidate_master_id, field_name, changed_at ASC, id ASC
      ),
      latest_steps AS (
        SELECT DISTINCT ON (candidate_master_id, field_name)
          candidate_master_id, field_name, new_value
        FROM field_steps
        ORDER BY candidate_master_id, field_name, changed_at DESC, id DESC
      ),
      real_changes AS (
        SELECT e.candidate_master_id, e.field_name, e.old_value
        FROM earliest_steps e
        JOIN latest_steps l ON l.candidate_master_id = e.candidate_master_id AND l.field_name = e.field_name
        WHERE e.old_value IS DISTINCT FROM l.new_value
      ),
      flattened AS (
        SELECT candidate_master_id,
          MAX(old_value) FILTER (WHERE field_name = 'email') AS email_old,
          MAX(old_value) FILTER (WHERE field_name = 'job_management_level') AS level_old,
          MAX(old_value) FILTER (WHERE field_name = 'accenture_candidate_stage') AS stage_old,
          MAX(old_value) FILTER (WHERE field_name = 'current_cid_source') AS cidsource_old,
          MAX(old_value) FILTER (WHERE field_name = 'application_completion_status') AS completion_old
        FROM real_changes
        GROUP BY candidate_master_id
      )
      UPDATE candidate_master cm SET
        email = COALESCE(fl.email_old, cm.email),
        job_management_level = COALESCE(fl.level_old, cm.job_management_level),
        accenture_candidate_stage = COALESCE(fl.stage_old, cm.accenture_candidate_stage),
        current_cid_source = COALESCE(fl.cidsource_old, cm.current_cid_source),
        application_completion_status = COALESCE(fl.completion_old, cm.application_completion_status)
      FROM flattened fl
      WHERE cm.id = fl.candidate_master_id
    `;

    // Locks and last_accenture_report_date can flip/update WITHOUT any
    // candidate_sync_changes row ever being logged — a usable value that
    // merely confirmed the already-stored value (zero real steps) still
    // flips a lock true and still advances the report-date backstop (see
    // migration 023's doc comment for the report-date half of this). So
    // these three updates must NOT be scoped by "rows this sync_id logged
    // a history row for" (that silently misses every zero-step touch,
    // found by rolling back a real run at full scale and finding 2,360
    // locked rows survive when there should be zero) — they're scoped by
    // `cm.last_accenture_sync_id = syncId`, the one column already proven
    // to be set unconditionally on EVERY touch, matched or inserted. This
    // MUST run before the last_accenture_sync_id reset below, which is the
    // one update allowed to consume that same old value last.
    await tx`
      UPDATE candidate_master cm SET
        email_accenture_locked = EXISTS (
          SELECT 1 FROM candidate_sync_changes csc JOIN candidate_sync_history csh ON csh.id = csc.sync_id
          WHERE csc.candidate_master_id = cm.id AND csc.field_name = 'email' AND csh.kind = 'accenture_upload' AND csc.sync_id != ${syncId}
        )
      WHERE cm.last_accenture_sync_id = ${syncId}
    `;
    await tx`
      UPDATE candidate_master cm SET
        job_management_level_accenture_locked = EXISTS (
          SELECT 1 FROM candidate_sync_changes csc JOIN candidate_sync_history csh ON csh.id = csc.sync_id
          WHERE csc.candidate_master_id = cm.id AND csc.field_name = 'job_management_level' AND csh.kind = 'accenture_upload' AND csc.sync_id != ${syncId}
        )
      WHERE cm.last_accenture_sync_id = ${syncId}
    `;

    await tx`
      UPDATE candidate_master cm SET
        last_accenture_report_date = (
          SELECT to_char(MAX(csc.changed_at) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')
          FROM candidate_sync_changes csc JOIN candidate_sync_history csh ON csh.id = csc.sync_id
          WHERE csc.candidate_master_id = cm.id AND csh.kind = 'accenture_upload' AND csc.sync_id != ${syncId}
        )
      WHERE cm.last_accenture_sync_id = ${syncId}
    `;

    await tx`
      UPDATE candidate_master cm SET
        last_accenture_sync_id = (
          SELECT MAX(csh.id) FROM candidate_sync_changes csc JOIN candidate_sync_history csh ON csh.id = csc.sync_id
          WHERE csc.candidate_master_id = cm.id AND csh.kind = 'accenture_upload' AND csc.sync_id != ${syncId}
        )
      WHERE cm.last_accenture_sync_id = ${syncId}
    `;

    await tx`DELETE FROM candidate_master WHERE inserted_sync_id = ${syncId}`;
    await tx`DELETE FROM candidate_sync_changes WHERE sync_id = ${syncId}`;
    // candidate_review_flags.sync_id FK-references candidate_sync_history —
    // an invalid-CID row writes a fresh review flag on EVERY run (never
    // deduped), so a run that ever hit one leaves a row here too; found by
    // rolling back a real run at full scale and hitting
    // candidate_review_flags_sync_id_fkey. Must go before the history delete.
    await tx`DELETE FROM candidate_review_flags WHERE sync_id = ${syncId}`;
    await tx`DELETE FROM candidate_sync_history WHERE id = ${syncId}`;
  });
}

async function main() {
  const args = process.argv.slice(2);
  const syncIdArg = args.find((a) => a.startsWith("--sync-id="));
  const syncId = syncIdArg ? Number(syncIdArg.slice("--sync-id=".length)) : NaN;
  if (!syncIdArg || Number.isNaN(syncId)) {
    console.error("Usage: npx tsx scripts/candidate-accenture-rollback.ts --sync-id=<R> [--apply --confirm-rows=<N> [--allow-prod]]");
    process.exitCode = 1;
    return;
  }

  const execute = args.includes("--apply");
  const allowProd = args.includes("--allow-prod");
  const confirmArg = args.find((a) => a.startsWith("--confirm-rows="));
  const confirmRows = confirmArg ? Number(confirmArg.slice("--confirm-rows=".length)) : null;

  const url = process.env.POSTGRES_URL?.trim();
  if (!url) {
    console.error("POSTGRES_URL is not set.");
    process.exitCode = 1;
    return;
  }
  const { host, dbName } = parseTarget(url);
  console.log(`Target database host: ${host}`);
  console.log(`Target database name: ${dbName}`);

  const sql = makeSqlClient(url);
  try {
    await sql.unsafe("SET default_transaction_read_only = on");
    const run = await sql<{ id: number; kind: string | null; result: string; source_filename: string | null; started_at: string }[]>`
      SELECT id, kind, result, source_filename, started_at FROM candidate_sync_history WHERE id = ${syncId}
    `;
    if (run.length === 0) {
      console.error(`No candidate_sync_history row with id=${syncId}.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Run: kind=${run[0].kind} result=${run[0].result} source=${run[0].source_filename} started_at=${run[0].started_at}`);

    const preview = await computePreview(sql, syncId);
    console.log("\nDry-run preview (zero writes, provably read-only):");
    console.log(`  historyRowCount (to delete): ${preview.historyRowCount}`);
    console.log(`  touchedRowCount (matched + inserted): ${preview.touchedRowCount}`);
    console.log(`  insertedRowCount (to DELETE outright): ${preview.insertedRowCount}`);
    console.log(`  fieldRestoreCounts: ${JSON.stringify(preview.fieldRestoreCounts)}`);

    if (!execute) {
      console.log("\nNo --apply given — this was a dry run only. Nothing was written.");
      return;
    }

    if (dbName === PROD_DB_NAME && !allowProd) {
      console.error(
        `\nRefusing --apply against a database named "${PROD_DB_NAME}" without --allow-prod. ` +
          "Pass --allow-prod explicitly if you really mean to write to it, after reviewing the dry-run preview above."
      );
      process.exitCode = 1;
      return;
    }

    if (confirmRows === null || Number.isNaN(confirmRows)) {
      console.error(
        `\n--apply requires --confirm-rows=<N>. This run touched ${preview.touchedRowCount} row(s) — ` +
          `re-run with --confirm-rows=${preview.touchedRowCount} to proceed, or omit --apply for a dry run.`
      );
      process.exitCode = 1;
      return;
    }
    if (confirmRows !== preview.touchedRowCount) {
      console.error(
        `\n--confirm-rows=${confirmRows} does not match this run's live recomputed touchedRowCount of ${preview.touchedRowCount}. ` +
          "Refusing to write."
      );
      process.exitCode = 1;
      return;
    }

    await sql.unsafe("SET default_transaction_read_only = off");
    console.log(`\n--confirm-rows=${confirmRows} matches. Rolling back sync_id=${syncId}...`);
    await applyRollback(sql, syncId);
    console.log("Rollback complete.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
