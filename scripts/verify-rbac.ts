/**
 * Phase 5 — RBAC / auth enforcement test suite (runner).
 *
 *   npm run test:rbac
 *   # or:  npx tsx scripts/verify-rbac.ts
 *
 * Runs every verify-rbac-*.ts suite in one process against real Postgres.
 * Must run where POSTGRES_URL + ARA_SESSION_SECRET + ARA_DASHBOARD_PASSWORD are
 * set — i.e. inside the ara-dashboard container:
 *
 *   docker exec ara-dashboard-prod sh -c 'cd /app && npm run test:rbac'
 *
 * Route handlers are imported and invoked directly with constructed Requests, so
 * the handler-level authorizeRequest gate runs for real; proxy.ts is exercised
 * too (verify-rbac-access-matrix). No test-framework dependency — same tsx-script
 * convention as the other scripts/verify-*.ts files.
 *
 * All fixtures use the `rbactest.` email prefix and are deleted before + after.
 * The two real accounts are never touched.
 */
import {
  cleanup,
  closeDb,
  loadEnv,
  openDb,
  type Suite,
  type TestResult,
} from "./verify-rbac-harness";

import { suite as signup } from "./verify-rbac-signup";
import { suite as userManagement } from "./verify-rbac-user-management";
import { suite as inviteLifecycle } from "./verify-rbac-invite-lifecycle";
import { suite as accessMatrix } from "./verify-rbac-access-matrix";
import { suite as sessions } from "./verify-rbac-sessions";

const SUITES: Array<[string, (db: Awaited<ReturnType<typeof openDb>>) => Promise<Suite>]> = [
  ["Req 1 — signup cannot exceed viewer", signup],
  ["Req 2 + 7 — user management + self-guards", userManagement],
  ["Req 3 — invite token lifecycle", inviteLifecycle],
  ["Req 4 — role-based access matrix", accessMatrix],
  ["Req 5 + 6 — deactivation + password change", sessions],
];

async function main(): Promise<void> {
  await loadEnv();
  const db = await openDb();

  console.log("========== PHASE 5 — RBAC / AUTH ENFORCEMENT ==========\n");

  const all: TestResult[] = [];
  for (const [title, run] of SUITES) {
    console.log(`\n── ${title} ──`);
    await cleanup(db);
    try {
      const s = await run(db);
      all.push(...s.results);
    } catch (error) {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`  FATAL  suite threw before completing\n${detail}`);
      all.push({ suite: title, name: "(suite crashed)", ok: false, detail });
    }
  }
  await cleanup(db);
  await closeDb();

  const failed = all.filter((r) => !r.ok);
  console.log("\n---------------- SUMMARY ----------------");
  const bySuite = new Map<string, { pass: number; fail: number }>();
  for (const r of all) {
    const e = bySuite.get(r.suite) ?? { pass: 0, fail: 0 };
    r.ok ? e.pass++ : e.fail++;
    bySuite.set(r.suite, e);
  }
  for (const [suite, { pass, fail }] of bySuite) {
    console.log(`  ${fail ? "FAIL" : "PASS"}  ${suite}: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
  }
  console.log("  ----------------------------------------");
  console.log(`  TOTAL: ${all.length - failed.length}/${all.length} passed`);

  if (failed.length) {
    console.log("\nFailures (nothing auto-fixed):");
    for (const f of failed) console.log(`  - [${f.suite}] ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log("\nRBAC enforcement: ALL CHECKS PASSED");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  try {
    await closeDb();
  } catch {
    /* ignore */
  }
});
