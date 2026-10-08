/**
 * In-memory Lateral Posted-button progress — same globalThis pattern as
 * `lateral-run-progress.ts` (so the cron/instrumentation bundle and every
 * API-route bundle in this process see the same snapshot), extended to
 * hold the full last-run result (not just "is one running") so a polling
 * GET route can show idle / running-since / done-with-result without
 * holding the HTTP connection open for the run's duration — mirrors
 * `startLateralJobAsync`'s established fire-and-forget pattern exactly.
 */

export interface LateralPostedSnapshot<TResult = unknown> {
  active: boolean;
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  result: TResult | null;
}

function idleSnapshot<TResult>(): LateralPostedSnapshot<TResult> {
  return { active: false, runId: null, startedAt: null, finishedAt: null, result: null };
}

const g = globalThis as typeof globalThis & {
  __araLateralPostedProgress?: { snapshot: LateralPostedSnapshot };
};
const state = (g.__araLateralPostedProgress ??= { snapshot: idleSnapshot() });

export function beginLateralPostedRun(runId: string): void {
  try {
    state.snapshot = { active: true, runId, startedAt: new Date().toISOString(), finishedAt: null, result: null };
  } catch {
    /* never let a marker bug break the caller */
  }
}

export function completeLateralPostedRun<TResult>(runId: string, result: TResult): void {
  try {
    if (state.snapshot.runId !== runId) return; // a newer/different run already superseded this one
    state.snapshot = { ...state.snapshot, active: false, finishedAt: new Date().toISOString(), result };
  } catch {
    /* never let a marker bug break the caller */
  }
}

export function getLateralPostedSnapshot<TResult>(): LateralPostedSnapshot<TResult> {
  try {
    return { ...state.snapshot } as LateralPostedSnapshot<TResult>;
  } catch {
    return idleSnapshot<TResult>();
  }
}

/** Used by the busy-lock message builder — "is a Posted run active, and since when." */
export function getLateralPostedHolder(): { startedAt: string } | null {
  try {
    return state.snapshot.active && state.snapshot.startedAt ? { startedAt: state.snapshot.startedAt } : null;
  } catch {
    return null;
  }
}
