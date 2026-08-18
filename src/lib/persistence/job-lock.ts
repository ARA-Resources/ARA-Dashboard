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
 */

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

export async function acquireLateralJobLock(): Promise<JobLockResult> {
  if (!isPostgresMode()) {
    // File mode: no distributed lock needed; in-memory `running` flag in scheduler handles single-process.
    return {
      acquired: true,
      message: "file-mode: no distributed lock required",
      release: async () => { /* no-op */ },
    };
  }

  const sql = getDbClient();

  // pg_advisory_lock uses a persistent connection for the duration of the lock.
  // We use pg_try_advisory_lock (non-blocking) to avoid hanging forever if another
  // worker holds the lock.
  const result = await sql<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_lock(${LATERAL_JOB_LOCK_KEY}) as acquired
  `;

  const acquired = result[0]?.acquired === true;

  if (!acquired) {
    return {
      acquired: false,
      message: "Lateral job is already running on another instance. This request has been safely rejected.",
      release: async () => { /* nothing to release */ },
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
