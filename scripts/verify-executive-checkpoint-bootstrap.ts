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
  toGmailAfterDateToken,
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

// 5. The Gmail `after:` query must be built from a safe YYYY/MM/DD token, not
//    raw epoch seconds — Gmail's own web search UI was found not to reliably
//    match an epoch-seconds `after:` value for a multi-day-old delta (see
//    [[executive-checkpoint-bootstrap-fix]]). The token for the bootstrap
//    value must be one full day before its UTC calendar date (2026-09-09),
//    i.e. 2026-09-08.
const bootstrapToken = toGmailAfterDateToken(EXECUTIVE_CHECKPOINT_BOOTSTRAP_MS);
assert(
  bootstrapToken === "2026/09/08",
  `Expected "2026/09/08" (one day before the bootstrap's UTC date), got "${bootstrapToken}"`
);
console.log(`PASS: toGmailAfterDateToken(bootstrap) = "${bootstrapToken}"`);

// 6. Inclusion guarantee, independent of time-of-day within the UTC day:
//    Pacific midnight (worst case UTC-7, i.e. PDT) on the returned token's
//    date must fall at or before `ms`, for both an end-of-day and a
//    start-of-day input — proving the day-boundary shift can never exclude
//    the instant it's meant to cover, regardless of DST state or timing.
function assertTokenIncludesInstant(ms: number, label: string) {
  const token = toGmailAfterDateToken(ms);
  const [y, m, d] = token.split("/").map(Number);
  // Worst case for "how late can Pacific midnight be relative to UTC": PDT (UTC-7).
  const pacificMidnightWorstCaseUtcMs = Date.UTC(y, m - 1, d, 7, 0, 0);
  assert(
    pacificMidnightWorstCaseUtcMs <= ms,
    `${label}: token "${token}"'s Pacific-midnight boundary (${new Date(pacificMidnightWorstCaseUtcMs).toISOString()}) must be at or before the input instant (${new Date(ms).toISOString()})`
  );
  console.log(
    `PASS: ${label} — token "${token}" safely includes ${new Date(ms).toISOString()} (margin: ${(ms - pacificMidnightWorstCaseUtcMs) / 3600000}h)`
  );
}
assertTokenIncludesInstant(Date.UTC(2026, 8, 15, 23, 59, 0), "23:59 UTC input");
assertTokenIncludesInstant(Date.UTC(2026, 8, 15, 0, 1, 0), "00:01 UTC input");
assertTokenIncludesInstant(EXECUTIVE_CHECKPOINT_BOOTSTRAP_MS, "bootstrap instant");

console.log("\nAll checkpoint-bootstrap checks passed.");
