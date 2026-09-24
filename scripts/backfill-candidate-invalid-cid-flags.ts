/**
 * ONE-TIME backfill: retroactively flag the specific `candidate_master` rows
 * that were inserted by the very first live Oorwin sync run
 * (candidate_sync_history.id=2, "ACCI Candidate Master Tracker Test -
 * Anurag Shah-4 (1).xlsx", 2026-09-24) BEFORE the invalid-CID-format and
 * missing-JR-ID checks existed (migration 018 / candidate-sync-engine.ts).
 *
 * Scope is deliberately narrow and hand-reviewed — exactly the 3 CIDs below,
 * NOT the full ~780-row historical scope found across the whole table
 * (most of which predates Oorwin entirely, from the one-time 2026-09-15
 * legacy import already processed once by
 * migrate-candidate-master-to-oorwin-schema.ts). Do not widen this list to
 * "every row that currently fails the CID regex" without a fresh, explicit
 * decision — see the investigation this script came out of.
 *
 * This is FLAG-ONLY: it never updates or deletes a candidate_master row.
 * The rows stay exactly as they are; only a `candidate_review_flags` row is
 * added per issue, same pattern the legacy migration script used for its
 * own retroactive flags (one `candidate_sync_history` row for the whole
 * backfill run, so every flag has a real, traceable sync_id).
 *
 * Usage:
 *   npx tsx scripts/backfill-candidate-invalid-cid-flags.ts --dry-run
 *   npx tsx scripts/backfill-candidate-invalid-cid-flags.ts
 *
 * Requires migration 018 already applied (candidate_review_flags.reason
 * CHECK constraint must allow 'invalid_candidate_id' /
 * 'missing_job_requisition_id' before the real run can insert them —
 * --dry-run does not touch the DB at all, so it works either way).
 */

import postgres from "postgres";

const BACKFILL_SENTINEL = "backfill-invalid-cid-review-flags-2026-09-24";

/** Hand-reviewed, exact scope — see the file header. */
const TARGET_CIDS = [
  "6300483559",
  "data integration, enhancing reporting accuracy and performance through Optimized SQL queries and stored procedures.",
  "c27835193",
];

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

const CID_FORMAT_REGEX = /^C[0-9]+$/;

function isValidCidFormat(cid: string): boolean {
  return CID_FORMAT_REGEX.test(cid.trim());
}

function isBlankJobRequisitionId(jr: string): boolean {
  const trimmed = jr.trim();
  return trimmed === "" || trimmed === "-";
}

interface CandidateRow {
  id: number;
  cid: string;
  name: string;
  contact_number: string;
  job_requisition_id: string;
  primary_skills: string;
  customer: string;
  status: string;
  submitted_date: string;
  created_at: string;
  updated_at: string;
}

function printRowDetail(row: CandidateRow, flagsToWrite: string[]) {
  console.log(`\n  id=${row.id}  cid=${JSON.stringify(row.cid)}`);
  console.log(`    name:                 ${row.name}`);
  console.log(`    contact_number:       ${row.contact_number}`);
  console.log(`    job_requisition_id:   ${row.job_requisition_id}`);
  console.log(`    primary_skills:       ${row.primary_skills}`);
  console.log(`    customer:             ${row.customer}`);
  console.log(`    status:               ${row.status}`);
  console.log(`    submitted_date:       ${row.submitted_date}`);
  console.log(`    created_at:           ${row.created_at}`);
  console.log(`    updated_at:           ${row.updated_at}`);
  console.log(`    -> flags to write:    ${flagsToWrite.join(", ")}`);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const startedAt = new Date();

  const sql = getDb();
  try {
    if (!dryRun) {
      const alreadyRun = await sql<{ id: number }[]>`
        SELECT id FROM candidate_sync_history
        WHERE source_filename = ${BACKFILL_SENTINEL}
        LIMIT 1
      `;
      if (alreadyRun.length > 0) {
        console.error(
          `This backfill has already run (candidate_sync_history.id=${alreadyRun[0].id}). Refusing to run again.`
        );
        process.exit(1);
      }
    }

    const rows = await sql<CandidateRow[]>`
      SELECT id, cid, name, contact_number, job_requisition_id, primary_skills,
             customer, status, submitted_date, created_at, updated_at
      FROM candidate_master
      WHERE cid = ANY(${TARGET_CIDS})
    `;

    console.log("\n========== CANDIDATE INVALID-CID BACKFILL ==========");
    console.log(`Target CIDs (hand-reviewed, ${TARGET_CIDS.length} total):`);
    for (const cid of TARGET_CIDS) console.log(`  - ${JSON.stringify(cid)}`);

    const foundCids = new Set(rows.map((r) => r.cid));
    const missing = TARGET_CIDS.filter((c) => !foundCids.has(c));
    if (missing.length > 0) {
      console.log(`\nWARNING: ${missing.length} target CID(s) not found in candidate_master (already handled, or the data changed since this script was written) — skipping:`);
      for (const cid of missing) console.log(`  - ${JSON.stringify(cid)}`);
    }

    const alreadyFlagged = await sql<{ cid: string; reason: string }[]>`
      SELECT DISTINCT cid, reason FROM candidate_review_flags
      WHERE cid = ANY(${TARGET_CIDS}) AND reason IN ('invalid_candidate_id', 'missing_job_requisition_id')
    `;
    if (alreadyFlagged.length > 0) {
      console.log(`\nNOTE: ${alreadyFlagged.length} flag(s) already exist for these CIDs (this backfill would add duplicates if run again):`);
      for (const f of alreadyFlagged) console.log(`  - cid=${JSON.stringify(f.cid)} reason=${f.reason}`);
    }

    console.log("\n-- Full detail of every row this backfill will flag --");
    const plans: { row: CandidateRow; reasons: ("invalid_candidate_id" | "missing_job_requisition_id")[] }[] = [];
    for (const row of rows) {
      const reasons: ("invalid_candidate_id" | "missing_job_requisition_id")[] = [];
      if (!isValidCidFormat(row.cid)) reasons.push("invalid_candidate_id");
      if (isBlankJobRequisitionId(row.job_requisition_id)) reasons.push("missing_job_requisition_id");
      if (reasons.length === 0) {
        console.log(`\n  id=${row.id} cid=${JSON.stringify(row.cid)} — SKIPPED: no longer fails either check, nothing to flag.`);
        continue;
      }
      plans.push({ row, reasons });
      printRowDetail(row, reasons);
    }

    const totalFlags = plans.reduce((n, p) => n + p.reasons.length, 0);
    console.log(`\nTotal rows to flag: ${plans.length}`);
    console.log(`Total review flags to write: ${totalFlags}`);

    if (dryRun) {
      console.log("\nDry run OK — no DB writes. Review the row detail above before running for real.");
      console.log("=====================================================\n");
      return;
    }

    if (plans.length === 0) {
      console.log("\nNothing to write. Exiting without creating a sync_history row.");
      console.log("=====================================================\n");
      return;
    }

    await sql.begin(async (tx) => {
      const [historyRow] = await tx<{ id: number }[]>`
        INSERT INTO candidate_sync_history
          (started_at, finished_at, result, source_filename, triggered_by,
           rows_in_sheet, inserted_count, updated_count, unchanged_count,
           quarantined_count, review_flag_count)
        VALUES
          (${startedAt}, NOW(), 'partial', ${BACKFILL_SENTINEL}, 'backfill-script',
           ${plans.length}, 0, 0, 0, 0, ${totalFlags})
        RETURNING id
      `;
      const syncId = historyRow.id;

      for (const plan of plans) {
        for (const reason of plan.reasons) {
          const detail =
            reason === "invalid_candidate_id"
              ? { rowId: plan.row.id, name: plan.row.name, rawCid: plan.row.cid }
              : { rowId: plan.row.id };
          await tx`
            INSERT INTO candidate_review_flags (sync_id, cid, reason, detail)
            VALUES (${syncId}, ${plan.row.cid}, ${reason}, ${sql.json(detail)})
          `;
        }
      }
    });

    console.log(`\nWrote ${totalFlags} review flag(s) across ${plans.length} row(s).`);
    console.log("=====================================================\n");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
