/**
 * In-memory Executive Posted-button progress. Mirrors
 * `lateral-posted-progress.ts` exactly — see that file's doc comment.
 */

export interface ExecutivePostedSnapshot<TResult = unknown> {
  active: boolean;
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  result: TResult | null;
}

function idleSnapshot<TResult>(): ExecutivePostedSnapshot<TResult> {
  return { active: false, runId: null, startedAt: null, finishedAt: null, result: null };
}

const g = globalThis as typeof globalThis & {
  __araExecutivePostedProgress?: { snapshot: ExecutivePostedSnapshot };
};
const state = (g.__araExecutivePostedProgress ??= { snapshot: idleSnapshot() });

export function beginExecutivePostedRun(runId: string): void {
  try {
    state.snapshot = { active: true, runId, startedAt: new Date().toISOString(), finishedAt: null, result: null };
  } catch {
    /* never let a marker bug break the caller */
  }
}

export function completeExecutivePostedRun<TResult>(runId: string, result: TResult): void {
  try {
    if (state.snapshot.runId !== runId) return;
    state.snapshot = { ...state.snapshot, active: false, finishedAt: new Date().toISOString(), result };
  } catch {
    /* never let a marker bug break the caller */
  }
}

export function getExecutivePostedSnapshot<TResult>(): ExecutivePostedSnapshot<TResult> {
  try {
    return { ...state.snapshot } as ExecutivePostedSnapshot<TResult>;
  } catch {
    return idleSnapshot<TResult>();
  }
}

export function getExecutivePostedHolder(): { startedAt: string } | null {
  try {
    return state.snapshot.active && state.snapshot.startedAt ? { startedAt: state.snapshot.startedAt } : null;
  } catch {
    return null;
  }
}
