/**
 * Verifies the Lateral / Executive job locks hold their advisory lock on ONE
 * reserved connection: acquire and unlock can't land on different pooled
 * connections ("you don't own a lock"), the held lock can't be re-entered
 * through a shared pooled session, and nothing is left locked afterwards.
 *
 * Run: npm run test:job-lock-reserved
 *
 * Needs a LOCAL Postgres (POSTGRES_URL on localhost/127.0.0.1): it takes and
 * releases the real Lateral/Executive lock keys, which would briefly make a
 * live pipeline report "busy". Writes no rows.
 */
import postgres from "postgres";

const LATERAL_KEY = 7482910234;
const EXECUTIVE_KEY = 7482910249;

// Postgres notices (e.g. "you don't own a lock of type ExclusiveLock") reach
// postgres.js's default `onnotice`, which is console.log. Capture them all.
const notices: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  const first = args[0] as { message?: unknown; severity?: unknown } | undefined;
  if (first && typeof first === "object" && typeof first.message === "string") {
    notices.push(`${String(first.severity ?? "")} ${first.message}`);
    return;
  }
  originalLog(...args);
};

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function pass(msg: string) {
  originalLog(`PASS: ${msg}`);
}

async function main() {
  const url = process.env.POSTGRES_URL?.trim() ?? "";
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    throw new Error("Refusing to run: POSTGRES_URL must point at localhost/127.0.0.1.");
  }
  process.env.ARA_PERSISTENCE = "postgres";

  const { acquireLateralJobLock, acquireExecutiveJobLock } = await import(
    "../src/lib/persistence/job-lock"
  );
  const { getDbClient, closeDbClient } = await import(
    "../src/lib/persistence/db-client"
  );
  const pool = getDbClient();
  // Independent single-connection observer, never shares a session with the pool.
  const observer = postgres(url, { max: 1, ssl: false, onnotice: () => undefined });

  const advisoryLockCount = async () => {
    const rows = await observer<{ c: number }[]>`
      SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory'
    `;
    return rows[0].c;
  };
  const heldElsewhere = async (key: number) => {
    const rows = await observer<{ got: boolean }[]>`
      SELECT pg_try_advisory_lock(${key}) AS got
    `;
    if (rows[0].got) await observer`SELECT pg_advisory_unlock(${key})`;
    return !rows[0].got;
  };
  const churn = (n: number) =>
    Promise.all(Array.from({ length: n }, () => pool`SELECT pg_sleep(0.01)`));

  try {
    assert((await advisoryLockCount()) === 0, "advisory locks already held before the test");
    // Open every pool connection so later calls really spread across them.
    await Promise.all(Array.from({ length: 5 }, () => pool`SELECT pg_sleep(0.05)`));

    // 1. Acquire Lateral; an independent session sees it held.
    const lateral = await acquireLateralJobLock();
    assert(lateral.acquired, "Lateral lock not acquired");
    assert(await heldElsewhere(LATERAL_KEY), "Lateral lock not visible as held to another session");
    pass("1. Lateral lock acquired and held (independent session is refused)");

    // 2. Re-entry: while held, no further acquire may succeed — sequential and
    //    concurrent, interleaved with pool churn so calls hit every connection.
    for (let i = 0; i < 10; i += 1) {
      await churn(5);
      const again = await acquireLateralJobLock();
      assert(!again.acquired, `re-entrant acquire #${i + 1} succeeded while held`);
    }
    const concurrent = await Promise.all(
      Array.from({ length: 10 }, () => acquireLateralJobLock())
    );
    assert(
      concurrent.every((r) => !r.acquired),
      "a concurrent acquire succeeded while the lock was held"
    );
    pass("2. 20 further acquires (10 sequential + 10 concurrent) all refused while held");

    // 3. Churn the pool, then release — nothing may stay locked.
    await churn(50);
    await lateral.release();
    assert((await advisoryLockCount()) === 0, "advisory lock left behind after Lateral release");
    assert(!(await heldElsewhere(LATERAL_KEY)), "Lateral lock still held after release");
    pass("3. Released after 50 concurrent pool queries; no advisory lock remains");

    // 4. Lateral + Executive concurrently (the same-minute schedule case).
    const [lat, exe] = await Promise.all([acquireLateralJobLock(), acquireExecutiveJobLock()]);
    assert(lat.acquired && exe.acquired, "concurrent Lateral+Executive acquire failed");
    assert(
      (await heldElsewhere(LATERAL_KEY)) && (await heldElsewhere(EXECUTIVE_KEY)),
      "both locks should be held"
    );
    await churn(50);
    await Promise.all([lat.release(), exe.release()]);
    assert((await advisoryLockCount()) === 0, "advisory locks left after concurrent release");
    pass("4. Lateral + Executive acquired and released concurrently; none left behind");

    // 5. Double release is a no-op, and the pool still works.
    await lat.release();
    await exe.release();
    const ping = await pool<{ ok: number }[]>`SELECT 1 AS ok`;
    assert(ping[0].ok === 1, "pool unusable after double release");
    pass("5. Double release is a no-op; pool still healthy");

    // 6. Immediate reacquire — no stale "busy".
    const [lat2, exe2] = await Promise.all([acquireLateralJobLock(), acquireExecutiveJobLock()]);
    assert(lat2.acquired && exe2.acquired, "immediate reacquire reported busy");
    await Promise.all([lat2.release(), exe2.release()]);
    assert((await advisoryLockCount()) === 0, "advisory locks left after reacquire cycle");
    pass("6. Immediate reacquire of both succeeds; nothing left locked");

    const lockNotices = notices.filter((n) => /own a lock/i.test(n));
    assert(
      lockNotices.length === 0,
      `got ${lockNotices.length} "you don't own a lock" notice(s): ${lockNotices.join(" | ")}`
    );
    pass(`0 "you don't own a lock" notices (${notices.length} notices captured in total)`);
    originalLog("\nALL JOB-LOCK CHECKS PASSED");
  } finally {
    await observer.end();
    await closeDbClient();
  }
}

main().catch((error) => {
  originalLog(error instanceof Error ? error.message : error);
  process.exit(1);
});
