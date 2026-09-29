/**
 * ONE-TIME cleanup, run BEFORE the separate ACCI-workbook refresh (not part
 * of this script): removes rows in `candidate_master` that carry no usable
 * data and fixes one known data-entry error, so the refresh's own row
 * reconciliation starts from a clean base.
 *
 * 1. DELETE 708 rows:
 *    - 706 rows where every business column is the "-" placeholder (the
 *      tail of the original 2026-09-15 legacy import that never got any
 *      real data at all — verified to be exactly the contiguous id range
 *      11246-11951, nothing else).
 *    - 2 further rows (id 8956 "Chethan Sadhanshive", id 9459 with a blank
 *      name and only a "CID Pending" comment) that also match nothing in
 *      the refresh workbook, hand-identified in the investigation this
 *      script came out of.
 * 2. FIX id 7458: its `cid` is the literal, malformed concatenation
 *    "C25246904C25249665" (two real-looking CIDs stuck together with no
 *    separator) — set to "C25246904" only, name/everything else untouched.
 *    (See the dry-run's "C25249665 lookup" output for whether that second
 *    fragment belongs to a different real candidate elsewhere.)
 *
 * Dry-run by default — prints everything this WOULD do and changes
 * NOTHING. Requires an explicit --apply to write, and even then hard-fails
 * before touching the DB if any safety check below doesn't hold (never a
 * partial change — either every check passes and the whole transaction
 * commits, or nothing happens).
 *
 * Safety checks (all of them, every run, dry-run or --apply):
 *  - The live "every business column is '-'" row set must be EXACTLY 706
 *    rows spanning ids 11246-11951 with no gaps and no outliers elsewhere
 *    in the table — not just "at least 706".
 *  - ids 8956 and 9459 must exist and still hold the exact identity this
 *    script expects (their real values may differ if this changes, but
 *    the checked fields must match — see EXTRA_DELETE_IDS below).
 *  - None of the 708 delete-candidates may have `inserted_sync_id` or
 *    `last_touched_at` set (would mean a sync actually touched the row —
 *    unexpected for a "blank/orphaned" row, treated as a hard stop).
 *  - No `candidate_review_flags` row may reference any of the 708 ids via
 *    `detail->>'rowId'` (the only place a row id appears in that table).
 *    `candidate_sync_changes` has no row-id-carrying column at all, so
 *    instead any row with `cid='-'` there blocks the run outright (can't
 *    be disambiguated to a specific id, so treated as a hit).
 *  - id 7458's current `cid`/`name` must exactly match the expected
 *    pre-fix values.
 * Any failure aborts immediately, prints exactly what didn't match, and
 * makes no database changes at all (checks run before the transaction
 * even opens).
 *
 * Usage:
 *   npx tsx scripts/cleanup-candidate-master-rows.ts             (dry run)
 *   npx tsx scripts/cleanup-candidate-master-rows.ts --apply     (writes)
 *
 * Before running --apply against prod: take an off-container pg_dump of
 * candidate_master (+ candidate_review_flags, candidate_sync_changes,
 * candidate_sync_history for full traceability) to a file outside the
 * repo, e.g.:
 *   pg_dump "$POSTGRES_URL" -t candidate_master -t candidate_review_flags \
 *     -t candidate_sync_changes -t candidate_sync_history \
 *     --no-owner --no-privileges > /path/outside/repo/candidate_tables_$(date +%Y%m%d_%H%M%S).sql
 *   chmod 600 that file.
 * This script does not take the dump itself — do it as a separate step
 * first, same as every other one-off script in this codebase.
 */

import postgres from "postgres";
import * as XLSX from "xlsx";
import { readFileSync } from "fs";

const BUSINESS_COLUMNS = [
  "cid", "name", "gender", "contact_number", "date_of_upload", "submitter",
  "customer", "job_requisition_id", "primary_skills", "job_management_level",
  "market", "submitted_date", "status", "submission_comments", "email", "client_spoc",
] as const;

const EXPECTED_BLANK_COUNT = 706;
const EXPECTED_BLANK_MIN_ID = 11246;
const EXPECTED_BLANK_MAX_ID = 11951;

/** Hand-reviewed, exact scope — see file header. Real values may have
 * drifted since this was written; the identity check below catches that. */
const EXTRA_DELETE_IDS = [8956, 9459] as const;
const EXPECTED_EXTRA_IDENTITY: Record<number, { name: string; submission_comments: string }> = {
  8956: { name: "Chethan Sadhanshive", submission_comments: "-" },
  9459: { name: "-", submission_comments: "CID Pending" },
};

const FIX_ROW_ID = 7458;
const FIX_ROW_EXPECTED_CID = "C25246904C25249665";
const FIX_ROW_EXPECTED_NAME = "KUMAR PARIDA";
const FIX_ROW_NEW_CID = "C25246904";
/** The second CID fragment stuck onto FIX_ROW_ID's cid — looked up (not
 * acted on) so a human can confirm it doesn't belong to someone else. */
const FIX_ROW_ORPHAN_FRAGMENT = "C25249665";

/** Hand-reviewed source workbook for the FIX_ROW_ORPHAN_FRAGMENT lookup. */
const WORKBOOK_PATH = "data/excel/ACCI Candidate Master Tracker 28092026.xlsx";
const WORKBOOK_SHEET = "ATCI";

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

interface CandidateRow {
  id: number;
  cid: string;
  name: string;
  gender: string;
  contact_number: string;
  date_of_upload: string;
  submitter: string;
  customer: string;
  job_requisition_id: string;
  primary_skills: string;
  job_management_level: string;
  market: string;
  submitted_date: string;
  status: string;
  submission_comments: string;
  email: string;
  client_spoc: string;
  inserted_sync_id: number | null;
  last_touched_at: string | null;
}

function printRowFull(row: CandidateRow) {
  console.log(`  id=${row.id}`);
  for (const col of BUSINESS_COLUMNS) {
    console.log(`    ${col.padEnd(21)}: ${JSON.stringify((row as unknown as Record<string, unknown>)[col])}`);
  }
  console.log(`    inserted_sync_id    : ${row.inserted_sync_id}`);
  console.log(`    last_touched_at     : ${row.last_touched_at}`);
}

/** Searches the workbook (every non-blank cell in every mapped column) and
 * candidate_master (every text column) for a literal substring match. */
function searchWorkbookForFragment(fragment: string): { row: number; col: string; value: string }[] {
  let buf: Buffer;
  try {
    buf = readFileSync(WORKBOOK_PATH);
  } catch (err) {
    console.log(`  (could not read workbook at ${WORKBOOK_PATH}: ${err instanceof Error ? err.message : String(err)})`);
    return [];
  }
  const wb = XLSX.read(buf, { type: "buffer", raw: true });
  const sheet = wb.Sheets[WORKBOOK_SHEET];
  if (!sheet) return [];
  const grid: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  const header = (grid[0] || []).map((c) => (c == null ? "" : String(c).trim()));
  const hits: { row: number; col: string; value: string }[] = [];
  for (let i = 1; i < grid.length; i += 1) {
    const row = grid[i] || [];
    for (let c = 0; c < row.length; c += 1) {
      const cell = row[c];
      if (cell === null || cell === undefined) continue;
      const text = String(cell);
      if (text.includes(fragment)) {
        hits.push({ row: i + 1, col: header[c] || `col${c}`, value: text });
      }
    }
  }
  return hits;
}

async function main() {
  const apply = process.argv.includes("--apply");

  const sql = getDb();
  try {
    console.log("\n========== CANDIDATE_MASTER CLEANUP (blank rows + id 7458 fix) ==========");
    console.log(apply ? "MODE: --apply (will write if every check passes)" : "MODE: dry run (no writes)");

    // ---------- Check 1: fully-blank row set ----------
    const blankRows = await sql<{ id: number }[]>`
      SELECT id FROM candidate_master
      WHERE cid='-' AND name='-' AND gender='-' AND contact_number='-' AND date_of_upload='-'
        AND submitter='-' AND customer='-' AND job_requisition_id='-' AND primary_skills='-'
        AND job_management_level='-' AND market='-' AND submitted_date='-' AND status='-'
        AND submission_comments='-' AND email='-' AND client_spoc='-'
      ORDER BY id
    `;
    // postgres.js returns bigint (id) columns as JS strings by default —
    // convert immediately so every downstream numeric comparison/ANY() bind
    // below actually works (this is exactly the bug this comment is next
    // to: caught it live when the dry run's own "contiguous: true" printout
    // still failed the check right after, because blankMin/blankMax were
    // strings being compared with `===` against number constants).
    const blankIds = blankRows.map((r) => Number(r.id));
    const blankCount = blankIds.length;
    const blankMin = blankIds.length ? blankIds[0] : null;
    const blankMax = blankIds.length ? blankIds[blankIds.length - 1] : null;
    const contiguous =
      blankMin !== null && blankMax !== null && blankMax - blankMin + 1 === blankCount;

    console.log(`\n-- Fully-blank rows --`);
    console.log(`  found: ${blankCount} (expected ${EXPECTED_BLANK_COUNT})`);
    console.log(`  id range: ${blankMin}-${blankMax} (expected ${EXPECTED_BLANK_MIN_ID}-${EXPECTED_BLANK_MAX_ID})`);
    console.log(`  contiguous (no gaps/outliers): ${contiguous}`);

    const blankCheckOk =
      blankCount === EXPECTED_BLANK_COUNT &&
      blankMin === EXPECTED_BLANK_MIN_ID &&
      blankMax === EXPECTED_BLANK_MAX_ID &&
      contiguous;

    if (!blankCheckOk) {
      console.error(
        `\nHARD FAIL: fully-blank row set does not match expectations. Aborting — no changes made.`
      );
      process.exit(1);
    }

    // ---------- Check 2: the 2 extra ids ----------
    const extraRows = await sql<CandidateRow[]>`
      SELECT id, cid, name, gender, contact_number, date_of_upload, submitter, customer,
             job_requisition_id, primary_skills, job_management_level, market,
             submitted_date, status, submission_comments, email, client_spoc,
             inserted_sync_id, last_touched_at
      FROM candidate_master WHERE id = ANY(${[...EXTRA_DELETE_IDS]})
      ORDER BY id
    `;
    console.log(`\n-- Extra delete candidates (full detail) --`);
    let extraCheckOk = extraRows.length === EXTRA_DELETE_IDS.length;
    for (const id of EXTRA_DELETE_IDS) {
      const row = extraRows.find((r) => Number(r.id) === id);
      const expected = EXPECTED_EXTRA_IDENTITY[id];
      if (!row) {
        console.error(`  id=${id}: NOT FOUND (expected it to exist)`);
        extraCheckOk = false;
        continue;
      }
      printRowFull(row);
      const matches = row.name === expected.name && row.submission_comments === expected.submission_comments;
      console.log(`    identity check: ${matches ? "OK" : "MISMATCH"}`);
      if (!matches) extraCheckOk = false;
    }
    if (!extraCheckOk) {
      console.error(`\nHARD FAIL: extra delete-candidate identity check failed. Aborting — no changes made.`);
      process.exit(1);
    }

    const allDeleteIds = [...blankIds, ...EXTRA_DELETE_IDS];

    // ---------- Check 3: inserted_sync_id / last_touched_at must be NULL ----------
    const touchedRows = await sql<{ id: number; inserted_sync_id: number | null; last_touched_at: string | null }[]>`
      SELECT id, inserted_sync_id, last_touched_at FROM candidate_master
      WHERE id = ANY(${allDeleteIds}) AND (inserted_sync_id IS NOT NULL OR last_touched_at IS NOT NULL)
    `;
    console.log(`\n-- inserted_sync_id / last_touched_at check --`);
    console.log(`  rows among the ${allDeleteIds.length} delete-candidates with either set: ${touchedRows.length}`);
    if (touchedRows.length > 0) {
      for (const r of touchedRows) console.log(`    id=${r.id} inserted_sync_id=${r.inserted_sync_id} last_touched_at=${r.last_touched_at}`);
      console.error(`\nHARD FAIL: one or more delete-candidates have sync/touch state set. Aborting — no changes made.`);
      process.exit(1);
    }

    // ---------- Check 4: no review-flag / sync-change row references these ids ----------
    const flagRefs = await sql<{ id: number; cid: string; reason: string; detail: unknown }[]>`
      SELECT id, cid, reason, detail FROM candidate_review_flags
      WHERE (detail->>'rowId')::bigint = ANY(${allDeleteIds})
    `;
    // candidate_sync_changes has no row-id-carrying detail column — the
    // only way it could reference one of these rows is via cid='-', which
    // (unlike candidate_review_flags) can't be disambiguated to a specific
    // id at all, so any such row is treated as a hit and blocks the run.
    const changeRefs = await sql<{ id: number; cid: string; field_name: string }[]>`
      SELECT id, cid, field_name FROM candidate_sync_changes WHERE cid = '-'
    `;
    console.log(`\n-- candidate_review_flags / candidate_sync_changes reference check --`);
    console.log(`  review_flags referencing a delete-candidate id: ${flagRefs.length}`);
    console.log(`  sync_changes referencing a delete-candidate id: ${changeRefs.length}`);
    if (flagRefs.length > 0 || changeRefs.length > 0) {
      for (const f of flagRefs) console.log(`    flag id=${f.id} cid=${f.cid} reason=${f.reason} detail=${JSON.stringify(f.detail)}`);
      for (const c of changeRefs) console.log(`    change id=${c.id} cid=${c.cid} field=${c.field_name}`);
      console.error(`\nHARD FAIL: a delete-candidate id is referenced. Aborting — no changes made.`);
      process.exit(1);
    }

    // ---------- Check 5: id 7458 pre-fix identity ----------
    const [fixRow] = await sql<CandidateRow[]>`
      SELECT id, cid, name, gender, contact_number, date_of_upload, submitter, customer,
             job_requisition_id, primary_skills, job_management_level, market,
             submitted_date, status, submission_comments, email, client_spoc,
             inserted_sync_id, last_touched_at
      FROM candidate_master WHERE id = ${FIX_ROW_ID}
    `;
    console.log(`\n-- id=${FIX_ROW_ID} fix preview --`);
    if (!fixRow) {
      console.error(`  NOT FOUND. HARD FAIL — aborting, no changes made.`);
      process.exit(1);
    }
    printRowFull(fixRow);
    const fixIdentityOk = fixRow.cid === FIX_ROW_EXPECTED_CID && fixRow.name === FIX_ROW_EXPECTED_NAME;
    console.log(`  identity check (cid="${FIX_ROW_EXPECTED_CID}", name="${FIX_ROW_EXPECTED_NAME}"): ${fixIdentityOk ? "OK" : "MISMATCH"}`);
    console.log(`  would set cid -> "${FIX_ROW_NEW_CID}" (name and every other column unchanged)`);
    if (!fixIdentityOk) {
      console.error(`\nHARD FAIL: id=${FIX_ROW_ID} current values don't match expectations. Aborting — no changes made.`);
      process.exit(1);
    }

    // ---------- Informational: does the orphan fragment belong to someone else? ----------
    console.log(`\n-- Lookup: does "${FIX_ROW_ORPHAN_FRAGMENT}" appear anywhere else? --`);
    const wbHits = searchWorkbookForFragment(FIX_ROW_ORPHAN_FRAGMENT);
    console.log(`  Workbook (${WORKBOOK_PATH}, sheet "${WORKBOOK_SHEET}"): ${wbHits.length} cell(s)`);
    for (const h of wbHits.slice(0, 20)) console.log(`    row ${h.row}, column "${h.col}": ${JSON.stringify(h.value)}`);

    const dbHits = await sql<{ id: number; cid: string; name: string }[]>`
      SELECT id, cid, name FROM candidate_master
      WHERE cid LIKE ${"%" + FIX_ROW_ORPHAN_FRAGMENT + "%"} AND id <> ${FIX_ROW_ID}
    `;
    console.log(`  candidate_master.cid (excluding id=${FIX_ROW_ID} itself): ${dbHits.length} row(s)`);
    for (const h of dbHits) console.log(`    id=${h.id} cid=${JSON.stringify(h.cid)} name=${JSON.stringify(h.name)}`);
    if (wbHits.length === 0 && dbHits.length === 0) {
      console.log(`  Not found anywhere else — no evidence "${FIX_ROW_ORPHAN_FRAGMENT}" belongs to a different, separate candidate.`);
    }

    // ---------- Summary ----------
    console.log(`\n-- Summary --`);
    console.log(`  Rows to DELETE: ${allDeleteIds.length} (${blankCount} fully-blank + ${EXTRA_DELETE_IDS.length} extra)`);
    console.log(`  Row to FIX: id=${FIX_ROW_ID}, cid "${FIX_ROW_EXPECTED_CID}" -> "${FIX_ROW_NEW_CID}"`);
    console.log(`  Projected candidate_master count after: <current> - ${allDeleteIds.length}`);

    if (!apply) {
      console.log(`\nDry run OK — every safety check passed, no DB writes. Re-run with --apply to write.`);
      console.log("===========================================================================\n");
      return;
    }

    const [{ count: beforeCount }] = await sql<{ count: string }[]>`SELECT count(*)::text FROM candidate_master`;

    await sql.begin(async (tx) => {
      await tx`DELETE FROM candidate_master WHERE id = ANY(${allDeleteIds})`;
      await tx`UPDATE candidate_master SET cid = ${FIX_ROW_NEW_CID} WHERE id = ${FIX_ROW_ID}`;
    });

    const [{ count: afterCount }] = await sql<{ count: string }[]>`SELECT count(*)::text FROM candidate_master`;
    const [fixed] = await sql<{ id: number; cid: string }[]>`SELECT id, cid FROM candidate_master WHERE id = ${FIX_ROW_ID}`;

    console.log(`\n-- Applied --`);
    console.log(`  candidate_master count: ${beforeCount} -> ${afterCount} (deleted ${allDeleteIds.length})`);
    console.log(`  id=${FIX_ROW_ID} cid is now: ${fixed?.cid}`);
    console.log("===========================================================================\n");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
