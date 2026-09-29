/**
 * PostgreSQL-backed distributed job lock.
 *
 * Uses pg_advisory_lock (session-level) via the postgres client.
 * The lock is automatically released when the database session closes,
 * so a crashed worker CANNOT leave a permanent stuck lock.
 *
 * Lock key: a stable integer derived from the job name.
 * All Lateral job runners (Cron endpoint + manual Run All) compete for
 * the SAME lock key — guaranteeing only one Lateral job runs at a time.
 *
 * Usage (postgres mode only):
 *
 *   const lock = await acquireLateralJobLock();
 *   if (!lock.acquired) {
 *     return { busy: true, message: lock.message };
 *   }
 *   try {
 *     await runLateralPipeline();
 *   } finally {
 *     await lock.release();
 *   }
 *
 * File mode:
 *   Returns a no-op lock that always succeeds (in-memory flag in lateral-scheduler.ts
 *   still provides single-process protection).
 *
 * Executive (Phase E1): `acquireExecutiveJobLock()` below is the same pattern
 * with its own advisory-lock key (EXECUTIVE_JOB_LOCK_KEY). The two locks are
 * independent — an Executive job running (or stuck) can never block a
 * Lateral job, and vice versa.
 *
 * Connection affinity: session-level advisory locks belong to ONE physical
 * connection. The pooled entry points (`acquireLateralJobLock` /
 * `acquireExecutiveJobLock`) therefore take the lock on a reserved connection
 * (`sql.reserve()`) and unlock on that same connection. Going through the
 * shared pool instead let the unlock land on a different connection ("you
 * don't own a lock"), leaving the lock held on the original one — and since
 * advisory locks are re-entrant per session, a second job whose acquire
 * landed on that connection could run concurrently. The `...On(sql)`
 * variants are for callers that already own a single connection (CLI
 * scripts with `max: 1`).
 */

import type postgres from "postgres";
import { isPostgresMode } from "./persistence-mode";
import { getDbClient } from "./db-client";

export interface JobLockResult {
  acquired: boolean;
  message: string;
  release: () => Promise<void>;
}

/**
 * Stable advisory lock key for the Lateral pipeline job.
 * Must be consistent across all server instances.
 * Value: hash of "ara_lateral_job" truncated to PostgreSQL bigint range.
 */
const LATERAL_JOB_LOCK_KEY = 7482910234; // stable, arbitrary prime-like number

/**
 * Stable advisory lock key for the Executive pipeline job (Phase E1).
 * Deliberately a different constant from LATERAL_JOB_LOCK_KEY so the two
 * pipelines can never block or interfere with each other — Lateral running
 * (or stuck) never prevents an Executive job from acquiring its own lock,
 * and vice versa.
 */
const EXECUTIVE_JOB_LOCK_KEY = 7482910249; // stable, arbitrary — distinct from Lateral's

/**
 * Stable advisory lock key for the Candidate Master Sheet hard-delete purge
 * job (migration 021). Its own distinct constant, same reasoning as
 * Executive's — a stuck/slow purge run can never block or be blocked by
 * Lateral or Executive.
 */
const CANDIDATE_PURGE_JOB_LOCK_KEY = 7482910263; // stable, arbitrary — distinct from the above

type SqlClient = ReturnType<typeof postgres>;

const LATERAL_BUSY_MESSAGE =
  "Lateral job is already running on another instance. This request has been safely rejected.";
const EXECUTIVE_BUSY_MESSAGE =
  "Executive job is already running on another instance. This request has been safely rejected.";
const CANDIDATE_PURGE_BUSY_MESSAGE =
  "Candidate purge job is already running on another instance. This request has been safely rejected.";

/**
 * Acquire a session advisory lock on ONE reserved connection and keep it
 * there until release, so acquire and unlock can never land on different
 * pooled connections and no other query can re-enter the lock through a
 * shared pooled session. A reserved connection is exempt from the pool's
 * `idle_timeout` and is only retired for `max_lifetime` after release, so the
 * lock can't vanish mid-job; if the process dies, the socket closes and
 * Postgres drops the lock.
 */
async function acquireReservedAdvisoryLock(
  key: number,
  busyMessage: string,
  acquiredMessage: string
): Promise<JobLockResult> {
  const reserved = await getDbClient().reserve();
  let acquired = false;
  try {
    const rows = await reserved<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(${key}) AS acquired
    `;
    acquired = rows[0]?.acquired === true;
  } catch (error) {
    reserved.release();
    throw error;
  }

  if (!acquired) {
    reserved.release();
    return {
      acquired: false,
      message: busyMessage,
      release: async () => {
        /* nothing to release */
      },
    };
  }

  let released = false;
  return {
    acquired: true,
    message: acquiredMessage,
    release: async () => {
      if (released) return;
      released = true;
      try {
        const rows = await reserved<{ unlocked: boolean }[]>`
          SELECT pg_advisory_unlock(${key}) AS unlocked
        `;
        if (rows[0]?.unlocked !== true) {
          console.warn(`[job-lock] Advisory lock ${key} was not held at release.`);
          // Never hand a connection that still holds locks back to the pool.
          await reserved`SELECT pg_advisory_unlock_all()`;
        }
      } catch {
        // The session is gone, and Postgres dropped the lock with it.
      } finally {
        reserved.release();
      }
    },
  };
}

/**
 * Acquire the shared Lateral advisory lock on a specific postgres.js client.
 * Prefer this when the caller already owns the DB connection (CLI / sync jobs)
 * so lock + transaction share the same session.
 */
export async function acquireLateralJobLockOn(
  sql: SqlClient
): Promise<JobLockResult> {
  const result = await sql<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_lock(${LATERAL_JOB_LOCK_KEY}) as acquired
  `;

  const acquired = result[0]?.acquired === true;

  if (!acquired) {
    return {
      acquired: false,
      message: LATERAL_BUSY_MESSAGE,
      release: async () => {
        /* nothing to release */
      },
    };
  }

  return {
    acquired: true,
    message: "Lateral job lock acquired",
    release: async () => {
      try {
        await sql`SELECT pg_advisory_unlock(${LATERAL_JOB_LOCK_KEY})`;
      } catch {
        // Lock auto-releases when connection closes — safe to ignore errors here
      }
    },
  };
}

export async function acquireLateralJobLock(): Promise<JobLockResult> {
  if (!isPostgresMode()) {
    // File mode: no distributed lock needed; in-memory `running` flag in scheduler handles single-process.
    return {
      acquired: true,
      message: "file-mode: no distributed lock required",
      release: async () => {
        /* no-op */
      },
    };
  }

  return acquireReservedAdvisoryLock(
    LATERAL_JOB_LOCK_KEY,
    LATERAL_BUSY_MESSAGE,
    "Lateral job lock acquired"
  );
}

/**
 * Acquire the shared Executive advisory lock on a specific postgres.js client.
 * Mirrors `acquireLateralJobLockOn` exactly, using EXECUTIVE_JOB_LOCK_KEY.
 * Only for callers that already own a single connection; app code uses
 * `acquireExecutiveJobLock()` (reserved connection).
 */
export async function acquireExecutiveJobLockOn(
  sql: SqlClient
): Promise<JobLockResult> {
  const result = await sql<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_lock(${EXECUTIVE_JOB_LOCK_KEY}) as acquired
  `;

  const acquired = result[0]?.acquired === true;

  if (!acquired) {
    return {
      acquired: false,
      message: EXECUTIVE_BUSY_MESSAGE,
      release: async () => {
        /* nothing to release */
      },
    };
  }

  return {
    acquired: true,
    message: "Executive job lock acquired",
    release: async () => {
      try {
        await sql`SELECT pg_advisory_unlock(${EXECUTIVE_JOB_LOCK_KEY})`;
      } catch {
        // Lock auto-releases when connection closes — safe to ignore errors here
      }
    },
  };
}

export async function acquireExecutiveJobLock(): Promise<JobLockResult> {
  if (!isPostgresMode()) {
    return {
      acquired: true,
      message: "file-mode: no distributed lock required",
      release: async () => {
        /* no-op */
      },
    };
  }

  return acquireReservedAdvisoryLock(
    EXECUTIVE_JOB_LOCK_KEY,
    EXECUTIVE_BUSY_MESSAGE,
    "Executive job lock acquired"
  );
}

/**
 * Acquire the Candidate Master Sheet hard-delete purge job's advisory lock
 * (migration 021). Mirrors `acquireExecutiveJobLock` exactly.
 */
export async function acquireCandidatePurgeJobLock(): Promise<JobLockResult> {
  if (!isPostgresMode()) {
    return {
      acquired: true,
      message: "file-mode: no distributed lock required",
      release: async () => {
        /* no-op */
      },
    };
  }

  return acquireReservedAdvisoryLock(
    CANDIDATE_PURGE_JOB_LOCK_KEY,
    CANDIDATE_PURGE_BUSY_MESSAGE,
    "Candidate purge job lock acquired"
  );
}
