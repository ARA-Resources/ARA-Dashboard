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
 * Lateral job, and vice versa. No caller exists yet; wired up in Phase E4.
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

type SqlClient = ReturnType<typeof postgres>;

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
      message:
        "Lateral job is already running on another instance. This request has been safely rejected.",
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

  return acquireLateralJobLockOn(getDbClient());
}

/**
 * Acquire the shared Executive advisory lock on a specific postgres.js client.
 * Mirrors `acquireLateralJobLockOn` exactly, using EXECUTIVE_JOB_LOCK_KEY.
 * Phase E1: no caller exists yet — the Executive job orchestrator (Phase E4)
 * will call `acquireExecutiveJobLock()` the same way `invokeLateralJob` calls
 * `acquireLateralJobLock()`.
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
      message:
        "Executive job is already running on another instance. This request has been safely rejected.",
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

  return acquireExecutiveJobLockOn(getDbClient());
}
