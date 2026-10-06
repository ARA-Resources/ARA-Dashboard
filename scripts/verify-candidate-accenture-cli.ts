/**
 * Validates scripts/candidate-accenture-upload.ts's prod-guard policy:
 *  - a dry run is provably read-only at the Postgres level (not just by
 *    code-path inspection) and is allowed against ANY database name,
 *    including one literally named "ara_db";
 *  - --apply against a database literally named "ara_db" is refused
 *    without --allow-prod;
 *  - --apply against a normally-named throwaway database is unaffected.
 *
 * This script NEVER passes --allow-prod to the CLI under any code path —
 * the "--allow-prod succeeds" branch is a 3-line boolean guard, verified by
 * reading candidate-accenture-upload.ts directly rather than executed here.
 *
 * Every database this script touches is a throwaway Postgres container
 * started fresh for this test — including the one named "ara_db", which is
 * a deliberately-named DECOY on its own throwaway container/host, never
 * the real prod container. Target host/db are printed before each spawn.
 *
 * DESTRUCTIVE on the throwaway DBs it's given via env vars below — never
 * run this against anything but a throwaway database.
 *
 * Run (from inside a container with both throwaway DBs reachable):
 *   DECOY_ARA_DB_URL=... NORMAL_DB_URL=... SAMPLE_FILE=/tmp/Accenture_Final_report.xlsx \
 *     npx tsx scripts/verify-candidate-accenture-cli.ts
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postgres from "postgres";

const execFileAsync = promisify(execFile);

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
}
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail?: string) {
  results.push({ name, status: pass ? "PASS" : "FAIL", detail });
}

const DECOY_URL = process.env.DECOY_ARA_DB_URL;
const NORMAL_URL = process.env.NORMAL_DB_URL;
const SAMPLE_FILE = process.env.SAMPLE_FILE || "/tmp/Accenture_Final_report.xlsx";

if (!DECOY_URL || !NORMAL_URL) {
  console.error("Set DECOY_ARA_DB_URL and NORMAL_DB_URL (both throwaway) before running this script.");
  process.exit(1);
}

async function runCli(url: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "npx",
      ["tsx", "scripts/candidate-accenture-upload.ts", ...args],
      { env: { ...process.env, POSTGRES_URL: url }, cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 }
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

async function countRows(url: string): Promise<{ master: number; history: number; changes: number }> {
  const sql = postgres(url, { max: 1, ssl: url.includes("127.0.0.1") || url.includes("localhost") ? false : "require" });
  try {
    const [m] = await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_master`;
    const [h] = await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_sync_history`;
    const [c] = await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_sync_changes`;
    return { master: Number(m.c), history: Number(h.c), changes: Number(c.c) };
  } finally {
    await sql.end();
  }
}

async function main() {
  // ===== 0. Direct proof: a connection with default_transaction_read_only=on cannot write =====
  {
    const sql = postgres(NORMAL_URL!, { max: 1, ssl: false });
    try {
      await sql.unsafe("SET default_transaction_read_only = on");
      let threw = false;
      let message = "";
      try {
        await sql`UPDATE candidate_sync_history SET result = 'failed' WHERE id = -1`;
      } catch (err) {
        threw = true;
        message = err instanceof Error ? err.message : String(err);
      }
      check(
        "Proof: a connection with default_transaction_read_only=on genuinely cannot execute a write (Postgres itself rejects it)",
        threw && /read-only/i.test(message),
        message
      );
      await sql.unsafe("SET default_transaction_read_only = off");
    } finally {
      await sql.end();
    }
  }

  // ===== 1. Dry run against the decoy "ara_db"-named throwaway: allowed, zero writes =====
  {
    const before = await countRows(DECOY_URL!);
    const { stdout, code } = await runCli(DECOY_URL!, ["--file", SAMPLE_FILE]);
    const after = await countRows(DECOY_URL!);
    check(
      "Dry run against a database literally named 'ara_db' is ALLOWED (no refusal)",
      code === 0 && /Dry run \(zero writes, provably read-only\):/.test(stdout),
      `exit=${code}`
    );
    check(
      "Dry run against 'ara_db' wrote absolutely nothing (row counts identical before/after)",
      before.master === after.master && before.history === after.history && before.changes === after.changes,
      JSON.stringify({ before, after })
    );
    check("Dry run output reports result: success", /result: success/.test(stdout));
  }

  // ===== 2. --apply against the decoy "ara_db" WITHOUT --allow-prod: refused =====
  {
    const before = await countRows(DECOY_URL!);
    const { stdout: dryStdout } = await runCli(DECOY_URL!, ["--file", SAMPLE_FILE]);
    const liveMatch = dryStdout.match(/matchedCidCount: (\d+)/);
    const liveMatchedCidCount = liveMatch ? liveMatch[1] : "0";
    const { stdout, stderr, code } = await runCli(DECOY_URL!, [
      "--file",
      SAMPLE_FILE,
      "--apply",
      `--confirm-matched=${liveMatchedCidCount}`,
    ]);
    const after = await countRows(DECOY_URL!);
    check(
      "--apply against 'ara_db' WITHOUT --allow-prod is REFUSED (non-zero exit)",
      code !== 0,
      `exit=${code}`
    );
    check(
      "--apply against 'ara_db' without --allow-prod prints a clear refusal message",
      /Refusing --apply against a database named "ara_db" without --allow-prod/.test(stderr),
      stderr.slice(0, 200)
    );
    check(
      "--apply against 'ara_db' without --allow-prod wrote absolutely nothing",
      before.master === after.master && before.history === after.history && before.changes === after.changes,
      JSON.stringify({ before, after })
    );
    check("No 'Applied (real writes)' banner ever printed", !/Applied \(real writes\)/.test(stdout));
  }

  // ===== 3. --apply against a NORMALLY-named throwaway (no --allow-prod needed): unaffected =====
  {
    const before = await countRows(NORMAL_URL!);
    const { stdout: dryStdout } = await runCli(NORMAL_URL!, ["--file", SAMPLE_FILE]);
    const liveMatch = dryStdout.match(/matchedCidCount: (\d+)/);
    const liveMatchedCidCount = liveMatch ? liveMatch[1] : "0";
    const { stdout, code } = await runCli(NORMAL_URL!, [
      "--file",
      SAMPLE_FILE,
      "--apply",
      `--confirm-matched=${liveMatchedCidCount}`,
    ]);
    const after = await countRows(NORMAL_URL!);
    check(
      "--apply against a normally-named throwaway succeeds without --allow-prod",
      code === 0 && /Applied \(real writes\):/.test(stdout),
      `exit=${code}`
    );
    check(
      "--apply against a normally-named throwaway actually wrote (row counts changed)",
      after.master > before.master || after.changes > before.changes,
      JSON.stringify({ before, after })
    );
  }

  // ===== 4. --apply refuses while an Oorwin sync run is IN PROGRESS (finished_at IS NULL) =====
  {
    const sql = postgres(NORMAL_URL!, { max: 1, ssl: NORMAL_URL!.includes("127.0.0.1") ? false : "require" });
    const [{ id: fakeRunId }] = await sql<{ id: number }[]>`
      INSERT INTO candidate_sync_history (started_at, result, kind) VALUES (NOW(), 'success', 'oorwin_upload') RETURNING id
    `;
    try {
      const before = await countRows(NORMAL_URL!);
      const { stdout: dryStdout } = await runCli(NORMAL_URL!, ["--file", SAMPLE_FILE]);
      const liveMatch = dryStdout.match(/matchedCidCount: (\d+)/);
      const liveMatchedCidCount = liveMatch ? liveMatch[1] : "0";
      const { stdout, stderr, code } = await runCli(NORMAL_URL!, [
        "--file",
        SAMPLE_FILE,
        "--apply",
        `--confirm-matched=${liveMatchedCidCount}`,
      ]);
      const after = await countRows(NORMAL_URL!);
      check("In-progress Oorwin run: --apply is REFUSED (non-zero exit)", code !== 0, `exit=${code}`);
      check(
        "In-progress Oorwin run: refusal names the in-progress run",
        new RegExp(`IN PROGRESS.*ids ${fakeRunId}\\b`).test(stderr) || stderr.includes(`ids ${fakeRunId},`),
        stderr.slice(0, 300)
      );
      check(
        "In-progress Oorwin run: wrote absolutely nothing",
        before.master === after.master && before.history === after.history && before.changes === after.changes,
        JSON.stringify({ before, after })
      );
      check("In-progress Oorwin run: no 'Applied (real writes)' banner ever printed", !/Applied \(real writes\)/.test(stdout));
    } finally {
      await sql`DELETE FROM candidate_sync_history WHERE id = ${fakeRunId}`;
      await sql.end();
    }
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
