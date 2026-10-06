/**
 * Validates the read-side fix to read-candidate-accenture-highlights.ts's
 * `getAccentureHoverData` — `rn_latest` now orders by `changed_at DESC,
 * id DESC` (was `id DESC` alone) — against the TWO cases that motivated
 * it, both produced by the REAL replay engine (not hand-built fixtures):
 *
 *  (a) INVERSION: a non-Accenture edit happens AFTER a field's last file
 *      step date but BEFORE the file's own cutoff (end of its last report
 *      date, IST). The field is NOT frozen (the edit is before cutoff),
 *      so Accenture's replay run DOES overwrite the live value — and the
 *      one step that does so is stamped with real time (see
 *      candidate-accenture-replay-engine.ts's "LATEST-WRITER ORDERING").
 *      `isAccentureLatest` must be TRUE (violet) — Accenture really is
 *      what the live cell currently holds. Under the OLD `id DESC`-only
 *      ordering this already worked (today's row gets a high id anyway),
 *      so this case mainly guards against ever regressing the fix.
 *
 *  (b) FROZEN: a non-Accenture edit happens AFTER the cutoff. The field
 *      IS frozen, so Accenture's replay run does NOT overwrite the live
 *      value — none of its steps for that field get a real-time stamp,
 *      they all stay backdated. `isAccentureLatest` must be FALSE — the
 *      real edit is what the live cell holds, and must win the
 *      violet/hover check. Under the OLD `id DESC`-only ordering this
 *      was broken: Accenture's backdated rows, inserted today, would
 *      still outrank the real edit by id alone.
 *
 * DESTRUCTIVE — throwaway/test DB only. Self-cleans in `finally`.
 *
 * Run: npx tsx scripts/verify-candidate-accenture-replay-latest-writer.ts
 */
import { closeDbClient, getDbClient } from "../src/lib/persistence/db-client";
import { getCandidateMasterById, type SqlClient } from "../src/services/persistence/read-candidate-master";
import { getAccentureHoverData } from "../src/services/persistence/read-candidate-accenture-highlights";
import { runCandidateAccentureReplaySync } from "../src/services/candidate-processing/candidate-accenture-replay-engine";
import type { CandidateAccentureParsedRow } from "../src/services/candidate-processing/candidate-accenture-parser";

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
}
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail?: string) {
  results.push({ name, status: pass ? "PASS" : "FAIL", detail });
}

const RUN_ID = Date.now();
const CID = (n: number) => `C5${RUN_ID}${n}`;
const cidsUsed: string[] = [];
const syncIdsUsed: number[] = [];

function serial(dateStr: string): string {
  const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
  const ms = new Date(`${dateStr}T00:00:00.000Z`).getTime();
  return String(Math.round((ms - EXCEL_EPOCH_UTC_MS) / 86_400_000));
}

function fileRow(cid: string, date: string, overrides: Partial<CandidateAccentureParsedRow> = {}): CandidateAccentureParsedRow {
  return {
    sheetRowNumber: 1,
    cid,
    name: "File Name",
    email: "-",
    level: "-",
    applicationCompletionStatus: "-",
    candidateStage: "-",
    currentCidSource: "-",
    reportDateRaw: serial(date),
    ...overrides,
  };
}

async function seedRow(sql: SqlClient, cid: string) {
  cidsUsed.push(cid);
  const [{ id }] = await sql<{ id: number }[]>`
    INSERT INTO candidate_master (
      cid, name, gender, contact_number, date_of_upload, submitter, customer,
      job_requisition_id, primary_skills, job_management_level, market,
      client_spoc, status, accenture_candidate_stage, current_cid_source,
      application_completion_status, screening_candidate_stage, disposition_reason,
      submitted_date, submission_comments, email
    ) VALUES (
      ${cid}, 'Seed Name', '-', '-', '-', '-', '-',
      '-', '-', '-', '-',
      '-', '-', '-', '-',
      '-', '-', '-',
      '-', '-', '-'
    ) RETURNING id
  `;
  const row = await getCandidateMasterById(Number(id), sql);
  if (!row) throw new Error("seedRow: row vanished immediately after insert");
  return row;
}

async function manualEdit(sql: SqlClient, cid: string, candidateMasterId: number, newValue: string, changedAtIso: string) {
  await sql`
    INSERT INTO candidate_sync_changes (sync_id, cid, field_name, old_value, new_value, candidate_master_id, changed_at)
    VALUES (NULL, ${cid}, 'accenture_candidate_stage', '-', ${newValue}, ${candidateMasterId}, ${changedAtIso}::timestamptz)
  `;
  await sql`UPDATE candidate_master SET accenture_candidate_stage = ${newValue} WHERE id = ${candidateMasterId}`;
}

async function main() {
  const sql = getDbClient();
  const existingCount = Number((await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_master`)[0]?.c ?? "0");
  if (existingCount > 100) {
    throw new Error(`candidate_master has ${existingCount} rows — refusing to run against what looks like real data.`);
  }

  try {
    // ===== (a) INVERSION: file's last step for this CID/field is 2026-02-10.
    // The file's OWN cutoff (its last report date overall) is 2026-09-01 —
    // the manual edit at 2026-03-01 is AFTER 02-10 but well BEFORE the
    // 09-01 cutoff, so the field is NOT frozen and Accenture legitimately
    // overwrites it. =====
    const cidInversion = CID(1);
    const seedInversion = await seedRow(sql, cidInversion);
    await manualEdit(sql, cidInversion, seedInversion.id, "ManualMid", "2026-03-01T06:30:00Z");

    const syncId1 = await (async () => {
      const rows = [
        fileRow(cidInversion, "2026-01-26", { candidateStage: "Screen" }),
        fileRow(cidInversion, "2026-02-10", { candidateStage: "Interview" }),
        // A later row in the SAME file, for a DIFFERENT CID, pushes the file's
        // own cutoff out to 2026-09-01 — this CID is simply absent from that
        // later date (reports aren't full snapshots, matching the real file).
        fileRow(CID(999), "2026-09-01", { candidateStage: "Screen" }),
      ];
      cidsUsed.push(CID(999));
      const [{ id }] = await sql<{ id: number }[]>`
        INSERT INTO candidate_sync_history (started_at, result, kind) VALUES (NOW(), 'success', 'accenture_upload') RETURNING id
      `;
      syncIdsUsed.push(Number(id));
      await runCandidateAccentureReplaySync(rows, Number(id), sql, { dryRun: false });
      return Number(id);
    })();

    const rowAfterInversion = await getCandidateMasterById(seedInversion.id, sql);
    check(
      "(a) Inversion setup: Accenture DID overwrite the live value (not frozen) — now Interview",
      rowAfterInversion?.accenture_candidate_stage === "Interview",
      rowAfterInversion?.accenture_candidate_stage
    );

    const hoverInversion = await getAccentureHoverData([cidInversion], sql);
    const entryInversion = hoverInversion.get(cidInversion)?.get("accenture_candidate_stage");
    check(
      "(a) Inversion: isAccentureLatest is TRUE — Accenture really is what the live cell holds, must be violet",
      entryInversion?.isAccentureLatest === true,
      JSON.stringify(entryInversion)
    );
    void syncId1;

    // ===== (b) FROZEN: manual edit AFTER the file's own cutoff (2026-09-01). =====
    const cidFrozen = CID(2);
    const seedFrozen = await seedRow(sql, cidFrozen);
    await manualEdit(sql, cidFrozen, seedFrozen.id, "ManualAfterCutoff", "2026-10-10T06:30:00Z");

    const syncId2 = await (async () => {
      const rows = [fileRow(cidFrozen, "2026-01-26", { candidateStage: "Screen" })];
      const [{ id }] = await sql<{ id: number }[]>`
        INSERT INTO candidate_sync_history (started_at, result, kind) VALUES (NOW(), 'success', 'accenture_upload') RETURNING id
      `;
      syncIdsUsed.push(Number(id));
      await runCandidateAccentureReplaySync(rows, Number(id), sql, { dryRun: false });
      return Number(id);
    })();
    void syncId2;

    const rowAfterFrozen = await getCandidateMasterById(seedFrozen.id, sql);
    check(
      "(b) Frozen setup: Accenture did NOT overwrite the live value — still ManualAfterCutoff",
      rowAfterFrozen?.accenture_candidate_stage === "ManualAfterCutoff",
      rowAfterFrozen?.accenture_candidate_stage
    );

    const hoverFrozen = await getAccentureHoverData([cidFrozen], sql);
    const entryFrozen = hoverFrozen.get(cidFrozen)?.get("accenture_candidate_stage");
    check(
      "(b) Frozen: isAccentureLatest is FALSE — the real edit wins, hover/violet must NOT claim Accenture",
      entryFrozen === undefined || entryFrozen.isAccentureLatest === false,
      JSON.stringify(entryFrozen)
    );
  } finally {
    await sql`DELETE FROM candidate_sync_changes WHERE cid = ANY(${cidsUsed})`;
    await sql`DELETE FROM candidate_master WHERE cid = ANY(${cidsUsed})`;
    if (syncIdsUsed.length > 0) {
      await sql`DELETE FROM candidate_sync_history WHERE id = ANY(${syncIdsUsed})`;
    }
    await closeDbClient();
  }

  console.log("\n========== TEST RESULTS ==========");
  let failures = 0;
  for (const r of results) {
    console.log(`[${r.status}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    if (r.status === "FAIL") failures += 1;
  }
  console.log(`\n${results.length - failures}/${results.length} passed.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
