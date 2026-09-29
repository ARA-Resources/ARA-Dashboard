/**
 * Manual dry-run/apply for the Candidate Master Sheet hard-delete purge
 * (migration 021) — the same DELETE the scheduled job
 * (candidate-purge-scheduler.ts) runs daily, exposed here for an
 * on-demand check or run (e.g. before ARA_CANDIDATE_PURGE_SCHEDULER=1 is
 * ever set, or to verify what the next scheduled run would do).
 *
 * Dry-run by default — prints every row that WOULD be permanently deleted
 * and changes NOTHING. Requires an explicit --apply to actually delete.
 *
 * Usage:
 *   POSTGRES_URL=... npx tsx scripts/purge-soft-deleted-candidates.ts            (dry run)
 *   POSTGRES_URL=... npx tsx scripts/purge-soft-deleted-candidates.ts --apply    (writes)
 */
import postgres from "postgres";
import { CANDIDATE_PURGE_RETENTION_DAYS } from "../src/services/candidate-processing/candidate-purge-scheduler";

function getDb() {
  const url = process.env.POSTGRES_URL?.trim();
  if (!url) {
    throw new Error("POSTGRES_URL is not set. Provide it in the environment or .env.local.");
  }
  return postgres(url, {
    max: 1,
    connect_timeout: 15,
    idle_timeout: 20,
    prepare: false,
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });
}

interface EligibleRow {
  id: number;
  cid: string;
  name: string;
  deleted_by: string | null;
  deleted_at: string;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const sql = getDb();

  try {
    console.log(
      apply
        ? "MODE: --apply (will permanently delete)"
        : "MODE: dry run (no writes) — re-run with --apply to actually delete"
    );
    console.log(`Retention: ${CANDIDATE_PURGE_RETENTION_DAYS} days.\n`);

    const eligible = await sql<EligibleRow[]>`
      SELECT id, cid, name, deleted_by, deleted_at
      FROM candidate_master
      WHERE deleted_at IS NOT NULL
        AND deleted_at < NOW() - (${CANDIDATE_PURGE_RETENTION_DAYS} * INTERVAL '1 day')
      ORDER BY deleted_at ASC
    `;

    const stillWithinRetention = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM candidate_master
      WHERE deleted_at IS NOT NULL
        AND deleted_at >= NOW() - (${CANDIDATE_PURGE_RETENTION_DAYS} * INTERVAL '1 day')
    `;

    if (eligible.length === 0) {
      console.log("No rows past the retention window. Nothing to purge.");
    } else {
      console.log(`${eligible.length} row(s) eligible for permanent deletion:`);
      for (const row of eligible) {
        console.log(
          `  id=${row.id} cid=${row.cid} name="${row.name}" deleted_by=${row.deleted_by ?? "unknown"} deleted_at=${row.deleted_at}`
        );
      }
    }
    console.log(
      `\n${stillWithinRetention[0]?.c ?? 0} soft-deleted row(s) still within the retention window (not eligible yet).`
    );

    if (apply && eligible.length > 0) {
      const deleted = await sql<{ id: number }[]>`
        DELETE FROM candidate_master
        WHERE deleted_at IS NOT NULL
          AND deleted_at < NOW() - (${CANDIDATE_PURGE_RETENTION_DAYS} * INTERVAL '1 day')
        RETURNING id
      `;
      console.log(`\nPermanently deleted ${deleted.length} row(s).`);
    } else if (!apply) {
      console.log("\nDry run only — no rows were deleted. Re-run with --apply to delete them.");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
