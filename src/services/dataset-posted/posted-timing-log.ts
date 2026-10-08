/**
 * Elapsed-time logging for the Posted button's Drive/Postgres steps only —
 * answers "where did the time go" for a single click, since no such
 * instrumentation existed anywhere in the codebase before this. Logs
 * counts/seconds only, never file contents or candidate data. Does not
 * touch any shared helper Run All calls.
 */
export function logPostedStepStart(dataset: "lateral" | "executive", step: string): number {
  console.info(`[posted-timing] ${dataset} ${step}: start`);
  return Date.now();
}

export function logPostedStepEnd(dataset: "lateral" | "executive", step: string, startedAtMs: number): void {
  const seconds = ((Date.now() - startedAtMs) / 1000).toFixed(2);
  console.info(`[posted-timing] ${dataset} ${step}: end, ${seconds}s`);
}
