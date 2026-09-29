/**
 * Candidate Master Sheet hard-delete purge scheduler (migration 021).
 *
 * A cut-down mirror of executive-scheduler.ts's cron-arming half: same
 * `globalThis` runtime-state pattern (Next bundles the instrumentation code
 * and each API route separately, so plain module-level state would arm
 * duplicate cron sets — see [[scheduler-arming-fix]]), same
 * `acquireReservedAdvisoryLock`-based distributed lock (its own key,
 * `CANDIDATE_PURGE_JOB_LOCK_KEY`, independent of Lateral/Executive's), and
 * the same `shouldThisProcessOwnLateralCron()` ownership check.
 *
 * Deliberately smaller than Executive's scheduler: there is no
 * per-installation configurable schedule, no DB config table, and no
 * manual "Run Now" UI — a purge is a fixed daily housekeeping job, not a
 * business pipeline a user tunes. The schedule (daily 03:00 Asia/Kolkata)
 * is a constant in this file; changing it means changing this file.
 */
import cron, { type ScheduledTask } from "node-cron";
import { getDbClient } from "@/lib/persistence/db-client";
import { acquireCandidatePurgeJobLock } from "@/lib/persistence/job-lock";
import {
  candidatePurgeSchedulerPolicyReason,
  isCandidatePurgeSchedulerAutoEnabled,
} from "@/lib/config/scheduler-policy";
import {
  schedulerOwnershipReason,
  shouldThisProcessOwnLateralCron,
} from "@/lib/config/scheduler-owner";

/** Fixed schedule: daily at 03:00 Asia/Kolkata — quiet hours, well clear of the Lateral/Executive sync windows. */
const CANDIDATE_PURGE_CRON_EXPRESSION = "0 3 * * *";
const CANDIDATE_PURGE_TIMEZONE = "Asia/Kolkata";
/** A soft-deleted row is hard-deleted once deleted_at is this many days in the past. */
export const CANDIDATE_PURGE_RETENTION_DAYS = 30;

type CandidatePurgeSchedulerRuntime = {
  task: ScheduledTask | null;
  bootstrapped: boolean;
  runningJobs: number;
  lastRunAt: string | null;
  lastPurgedCount: number | null;
};
const runtimeGlobal = globalThis as typeof globalThis & {
  __araCandidatePurgeScheduler?: CandidatePurgeSchedulerRuntime;
};
const rt = (runtimeGlobal.__araCandidatePurgeScheduler ??= {
  task: null,
  bootstrapped: false,
  runningJobs: 0,
  lastRunAt: null,
  lastPurgedCount: null,
});

export interface CandidatePurgeResult {
  ranAt: string;
  purgedCount: number;
  purgedRows: { id: number; cid: string; name: string; deletedBy: string | null; deletedAt: string }[];
  busy: boolean;
}

/**
 * Permanently deletes every `candidate_master` row whose `deleted_at` is
 * more than `CANDIDATE_PURGE_RETENTION_DAYS` days in the past. No FK points
 * at `candidate_master` (checked live), so a plain DELETE is safe.
 * `candidate_review_flags` / `candidate_sync_changes` rows for that CID are
 * deliberately left alone — both tables are append-only by design and the
 * row's audit trail should outlive the row (see candidate-manual-edit.ts's
 * delete comment); once no live row shares that CID they simply stop
 * surfacing in the UI on their own (same as any other CID with no live
 * row).
 */
export async function runCandidatePurge(): Promise<CandidatePurgeResult> {
  const ranAt = new Date().toISOString();
  const lock = await acquireCandidatePurgeJobLock();
  if (!lock.acquired) {
    console.info(`[candidate-purge] ${lock.message}`);
    return { ranAt, purgedCount: 0, purgedRows: [], busy: true };
  }

  rt.runningJobs += 1;
  try {
    const sql = getDbClient();
    // CANDIDATE_PURGE_RETENTION_DAYS interpolates as an ordinary numeric
    // parameter (not string-built SQL) — `<n> * INTERVAL '1 day'` is valid
    // Postgres and keeps this a plain parameterized query.
    const rows = await sql<
      { id: number; cid: string; name: string; deleted_by: string | null; deleted_at: string }[]
    >`
      DELETE FROM candidate_master
      WHERE deleted_at IS NOT NULL
        AND deleted_at < NOW() - (${CANDIDATE_PURGE_RETENTION_DAYS} * INTERVAL '1 day')
      RETURNING id, cid, name, deleted_by, deleted_at
    `;
    for (const row of rows) {
      console.info(
        `[candidate-purge] Permanently deleted candidate_master id=${row.id} cid=${row.cid} name="${row.name}" (soft-deleted by ${row.deleted_by ?? "unknown"} at ${row.deleted_at})`
      );
    }
    console.info(`[candidate-purge] Run complete: ${rows.length} row(s) permanently deleted.`);
    rt.lastRunAt = ranAt;
    rt.lastPurgedCount = rows.length;
    return {
      ranAt,
      purgedCount: rows.length,
      purgedRows: rows.map((r) => ({
        id: Number(r.id),
        cid: r.cid,
        name: r.name,
        deletedBy: r.deleted_by,
        deletedAt: new Date(r.deleted_at).toISOString(),
      })),
      busy: false,
    };
  } finally {
    rt.runningJobs -= 1;
    await lock.release();
  }
}

function stopCandidatePurgeTask() {
  if (rt.task) {
    void rt.task.destroy();
    rt.task = null;
  }
}

export function stopCandidatePurgeScheduler(): void {
  stopCandidatePurgeTask();
}

export async function startCandidatePurgeScheduler(): Promise<void> {
  if (!shouldThisProcessOwnLateralCron()) {
    console.info(
      `[candidate-purge] Scheduler bootstrap skipped in this process (${schedulerOwnershipReason()}).`
    );
    rt.bootstrapped = true;
    return;
  }

  if (!isCandidatePurgeSchedulerAutoEnabled()) {
    console.info(
      `[candidate-purge] Automatic purge not armed (${candidatePurgeSchedulerPolicyReason()}). Run scripts/purge-soft-deleted-candidates.ts manually if needed.`
    );
    rt.bootstrapped = true;
    return;
  }

  stopCandidatePurgeTask();
  rt.task = cron.schedule(
    CANDIDATE_PURGE_CRON_EXPRESSION,
    () => {
      void runCandidatePurge().catch((error) => {
        console.error("[candidate-purge] Scheduled run failed", error);
      });
    },
    {
      timezone: CANDIDATE_PURGE_TIMEZONE,
      noOverlap: true,
      name: "candidate-purge",
      missedExecutionTolerance: 0,
    }
  );
  console.info(
    `[candidate-purge] Armed: daily ${CANDIDATE_PURGE_CRON_EXPRESSION} ${CANDIDATE_PURGE_TIMEZONE} (retention ${CANDIDATE_PURGE_RETENTION_DAYS} days).`
  );
  rt.bootstrapped = true;
}

export function getCandidatePurgeSchedulerStatus() {
  return {
    armed: rt.task != null,
    running: rt.runningJobs > 0,
    lastRunAt: rt.lastRunAt,
    lastPurgedCount: rt.lastPurgedCount,
    notArmedReason: rt.task != null ? null : candidatePurgeSchedulerPolicyReason(),
  };
}
