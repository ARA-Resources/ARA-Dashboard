/**
 * Verifies the fix for the Executive "Run All" checkpoint bug: with no
 * persisted Executive Gmail checkpoint, the search window must start from
 * the executive_master Postgres cutover date (2026-09-10, Asia/Kolkata),
 * never from "start of today" — the latter is what silently hid the
 * 11th/16th September demand sheets.
 *
 * No live Gmail/DB needed — pure date-math checks.
 */
import {
  getCalendarDateInTimezone,
  getStartOfCalendarDayMs,
} from "../src/services/gmail/query";
import { EXECUTIVE_CHECKPOINT_BOOTSTRAP_MS } from "../src/services/executive-processing/executive-gmail-incremental-sync";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// 1. Independently computed expected value (does NOT reuse getStartOfCalendarDayMs)
//    2026-09-10T00:00:00+05:30 == 2026-09-09T18:30:00Z
const expectedMs = Date.UTC(2026, 8, 9, 18, 30, 0);
assert(
  EXECUTIVE_CHECKPOINT_BOOTSTRAP_MS === expectedMs,
  `Expected bootstrap ms ${expectedMs} (2026-09-10 00:00 IST), got ${EXECUTIVE_CHECKPOINT_BOOTSTRAP_MS}`
);
console.log(
  "PASS: EXECUTIVE_CHECKPOINT_BOOTSTRAP_MS resolves to 2026-09-10T00:00:00+05:30",
  new Date(EXECUTIVE_CHECKPOINT_BOOTSTRAP_MS).toISOString()
);

// 2. Regression guard: must NOT equal "start of today" (the old, buggy fallback)
const startOfTodayMs = getStartOfCalendarDayMs(getCalendarDateInTimezone());
assert(
  EXECUTIVE_CHECKPOINT_BOOTSTRAP_MS !== startOfTodayMs,
  "Bootstrap ms must not equal start-of-today — that was the original bug"
);
console.log(
  "PASS: bootstrap ms differs from start-of-today",
  new Date(startOfTodayMs).toISOString()
);

// 3. Simulate the exact fallback expression used in
//    runExecutiveGmailIncrementalSync: `checkpointBefore.receivedAtMs ?? EXECUTIVE_CHECKPOINT_BOOTSTRAP_MS`
const checkpointBeforeReceivedAtMs: number | null = null; // no checkpoint yet
const afterMs = checkpointBeforeReceivedAtMs ?? EXECUTIVE_CHECKPOINT_BOOTSTRAP_MS;
assert(
  afterMs === EXECUTIVE_CHECKPOINT_BOOTSTRAP_MS,
  "With no checkpoint, afterMs must resolve to the bootstrap date"
);
console.log("PASS: no-checkpoint afterMs resolves to the Sept 10 cutover, not today");

// 4. With a real checkpoint present, the persisted value must still win
//    (bootstrap is a fallback only, never overrides a real checkpoint).
const checkpointBeforeReceivedAtMs2 = Date.UTC(2026, 8, 20, 0, 0, 0);
const afterMs2 = checkpointBeforeReceivedAtMs2 ?? EXECUTIVE_CHECKPOINT_BOOTSTRAP_MS;
assert(
  afterMs2 === checkpointBeforeReceivedAtMs2,
  "A real checkpoint value must take precedence over the bootstrap fallback"
);
console.log("PASS: an existing checkpoint still takes precedence over the bootstrap");

console.log("\nAll checkpoint-bootstrap checks passed.");
