/**
 * In-memory "Executive Run All is holding the lock" marker.
 *
 * Executive has no equivalent of `lateral-run-progress.ts` today — Run All
 * is one synchronous request/response, not a polled multi-stage panel — so
 * there was previously nothing for a busy-lock caller to read to say WHICH
 * run holds the lock and since when. This file adds only that: who (trigger)
 * and when (startedAt), set/cleared by `invokeExecutiveJob` itself (two bare
 * lines there — see executive-job.ts).
 *
 * globalThis-backed, same reasoning as `lateral-run-progress.ts`. Every
 * exported function swallows its own errors so a bug here can never affect
 * Run All's control flow — the two call sites in executive-job.ts are
 * unguarded, bare calls specifically because this file guarantees they
 * cannot throw.
 */
import type { ExecutiveJobTrigger } from "@/types/executive-scheduler";

export interface ExecutiveRunHolder {
  trigger: ExecutiveJobTrigger;
  startedAt: string;
}

const g = globalThis as typeof globalThis & {
  __araExecutiveRunProgress?: { holder: ExecutiveRunHolder | null };
};
const state = (g.__araExecutiveRunProgress ??= { holder: null });

export function setExecutiveRunHolder(trigger: ExecutiveJobTrigger): void {
  try {
    state.holder = { trigger, startedAt: new Date().toISOString() };
  } catch {
    /* never let a marker bug break Run All */
  }
}

export function clearExecutiveRunHolder(): void {
  try {
    state.holder = null;
  } catch {
    /* never let a marker bug break Run All */
  }
}

export function getExecutiveRunHolder(): ExecutiveRunHolder | null {
  try {
    return state.holder;
  } catch {
    return null;
  }
}
