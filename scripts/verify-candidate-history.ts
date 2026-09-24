/**
 * C10 validation — the candidate history popup's data source
 * (`getCandidateChangeHistory`), queried the same way the API route does.
 *
 * Runs THREE sequential syncs touching the same CID, each changing a
 * different field, and confirms the returned history contains ALL of them
 * in chronological order — the opposite of C9's "latest sync only" rule,
 * which this same CID is also used to cross-check (its C9 highlight should
 * show only the third sync's field, while its C10 history shows all three).
 *
 * DESTRUCTIVE — writes to candidate_master / candidate_sync_history /
 * candidate_sync_changes. Throwaway/test DB only.
 *
 * Run: npx tsx scripts/verify-candidate-history.ts
 */
import { closeDbClient, getDbClient } from "../src/lib/persistence/db-client";
import { runCandidateSync } from "../src/services/candidate-processing/candidate-sync-engine";
import type { CandidateOorwinParsedRow } from "../src/services/candidate-processing/candidate-oorwin-parser";
import {
  getCandidateChangeHistory,
  getLatestCandidateChangedFields,
} from "../src/services/persistence/read-candidate-highlights";

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
}

function check(results: TestResult[], name: string, pass: boolean, detail?: string) {
  results.push({ name, status: pass ? "PASS" : "FAIL", detail });
}

function row(
  partial: Partial<CandidateOorwinParsedRow> & { sheetRowNumber: number; cid: string }
): CandidateOorwinParsedRow {
  return {
    firstName: "",
    middleName: "-",
    lastName: "",
    email: "-",
    mobile: "-",
    gender: "-",
    submitter: "-",
    customer: "-",
    clientSubmissionJr: "-",
    customerJobTitle: "-",
    market: "-",
    clientSpoc: "-",
    status: "-",
    submittedDate: "-",
    reasonForRejection: "-",
    submissionComments: "-",
    ...partial,
  };
}

const CID = "TEST-HIST-CID";

const BASE = {
  firstName: "History",
  lastName: "Person",
  mobile: "9100000001",
  email: "hist@example.com",
  gender: "Male",
  submitter: "Sub A",
  customer: "Cust A",
  customerJobTitle: "Skill A",
  market: "Mkt A",
  status: "Status A",
  submittedDate: "01/01/2026",
  submissionComments: "Comments A",
};

async function main() {
  const results: TestResult[] = [];
  const sql = getDbClient();

  try {
    const existingCount = Number(
      (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_master`)[0]?.c ?? "0"
    );
    if (existingCount > 100) {
      throw new Error(
        `candidate_master has ${existingCount} rows — refusing to run this destructive test against what looks like real data. Point POSTGRES_URL at a throwaway database.`
      );
    }

    await sql`
      INSERT INTO candidate_master (
        cid, name, gender, contact_number, date_of_upload, submitter, customer,
        job_requisition_id, primary_skills, job_management_level, market,
        client_spoc, status, submitted_date, submission_comments, email
      ) VALUES (
        ${CID}, 'History Person', 'Male', '9100000001', '01/01/2026', 'Sub A', 'Cust A',
        '-', 'Skill A', '-', 'Mkt A', '-', 'Status A', '01/01/2026', 'Comments A', 'hist@example.com'
      )
    `;

    const syncIds: number[] = [];

    // Sync 1: Customer changes.
    const [h1] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, result, source_filename, triggered_by)
      VALUES (NOW(), 'success', 'history-sync-1.xls', 'alice@example.com') RETURNING id
    `;
    syncIds.push(Number(h1.id));
    await runCandidateSync(
      [row({ sheetRowNumber: 1, cid: CID, ...BASE, customer: "Cust B" })],
      h1.id,
      sql
    );

    // Sync 2: Status changes.
    const [h2] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, result, source_filename, triggered_by)
      VALUES (NOW(), 'success', 'history-sync-2.xls', 'bob@example.com') RETURNING id
    `;
    syncIds.push(Number(h2.id));
    await runCandidateSync(
      [row({ sheetRowNumber: 1, cid: CID, ...BASE, customer: "Cust B", status: "Status B" })],
      h2.id,
      sql
    );

    // Sync 3: Market changes.
    const [h3] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, result, source_filename, triggered_by)
      VALUES (NOW(), 'success', 'history-sync-3.xls', 'carol@example.com') RETURNING id
    `;
    syncIds.push(Number(h3.id));
    await runCandidateSync(
      [row({ sheetRowNumber: 1, cid: CID, ...BASE, customer: "Cust B", status: "Status B", market: "Mkt B" })],
      h3.id,
      sql
    );

    // ===== The actual C10 query =====
    const history = await getCandidateChangeHistory(CID, sql);

    check(results, "History has exactly 3 entries (one per sync, not accumulated/deduped away)", history.length === 3, `got ${history.length}`);
    check(
      results,
      "Entry 1 (oldest) is Customer, old=Cust A new=Cust B, from sync 1",
      history[0]?.header === "Customer" &&
        history[0]?.oldValue === "Cust A" &&
        history[0]?.newValue === "Cust B" &&
        history[0]?.syncId === syncIds[0],
      JSON.stringify(history[0])
    );
    check(
      results,
      "Entry 2 is Status, old=Status A new=Status B, from sync 2",
      history[1]?.header === "Status" &&
        history[1]?.oldValue === "Status A" &&
        history[1]?.newValue === "Status B" &&
        history[1]?.syncId === syncIds[1],
      JSON.stringify(history[1])
    );
    check(
      results,
      "Entry 3 (newest) is Market, old=Mkt A new=Mkt B, from sync 3",
      history[2]?.header === "Market" &&
        history[2]?.oldValue === "Mkt A" &&
        history[2]?.newValue === "Mkt B" &&
        history[2]?.syncId === syncIds[2],
      JSON.stringify(history[2])
    );
    check(
      results,
      "Chronological order: changedAt strictly increasing across all 3 entries",
      new Date(history[0]!.changedAt).getTime() <= new Date(history[1]!.changedAt).getTime() &&
        new Date(history[1]!.changedAt).getTime() <= new Date(history[2]!.changedAt).getTime()
    );
    check(
      results,
      "Each entry's source_filename/triggered_by traces back to the right sync",
      history[0]?.sourceFilename === "history-sync-1.xls" &&
        history[0]?.triggeredBy === "alice@example.com" &&
        history[1]?.sourceFilename === "history-sync-2.xls" &&
        history[1]?.triggeredBy === "bob@example.com" &&
        history[2]?.sourceFilename === "history-sync-3.xls" &&
        history[2]?.triggeredBy === "carol@example.com"
    );

    // Cross-check against C9: the highlight (latest-only) view for the same
    // CID should show ONLY Market (sync 3's change) — proving C9 and C10
    // read the exact same underlying rows through genuinely different
    // filters, not two independently-approximated views that happen to agree.
    const latest = await getLatestCandidateChangedFields(sql);
    const latestFieldsForCid = latest.get(CID) ?? new Set<string>();
    check(
      results,
      "C9 cross-check: the 'latest sync only' view for this CID shows ONLY 'market' (not customer/status too)",
      latestFieldsForCid.size === 1 && latestFieldsForCid.has("market"),
      JSON.stringify([...latestFieldsForCid])
    );

    // Unknown CID / no history at all.
    const emptyHistory = await getCandidateChangeHistory("TEST-HIST-NEVER-EXISTED", sql);
    check(results, "A CID with no recorded changes returns an empty array, not an error", emptyHistory.length === 0);

    const blankHistory = await getCandidateChangeHistory("-", sql);
    check(results, "A blank/'-' cid returns an empty array without querying", blankHistory.length === 0);

    // -- cleanup --
    await sql`DELETE FROM candidate_sync_changes WHERE cid = ${CID}`;
    await sql`DELETE FROM candidate_master WHERE cid = ${CID}`;
    await sql`DELETE FROM candidate_sync_history WHERE id = ANY(${syncIds})`;
  } finally {
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
