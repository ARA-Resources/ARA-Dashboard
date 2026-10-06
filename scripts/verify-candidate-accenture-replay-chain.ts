/**
 * Pure, no-DB validation of the Accenture replay engine's smallest
 * building blocks:
 *  - candidate-excel-date.ts (Excel serial -> noon-IST date, cutoff math)
 *  - candidate-accenture-replay-engine.ts's computeAccentureReplayFieldChain
 *    (blank-skip, no final-equals-seed short-circuit / revert logging,
 *    case-insensitive email, frozen gate, live-write timestamp stamping)
 *
 * Run: npx tsx scripts/verify-candidate-accenture-replay-chain.ts
 */
import { accentureReportDateKey, istEndOfDayExclusiveUtc, parseAccentureReportDate } from "../src/services/candidate-processing/candidate-excel-date";
import { computeAccentureReplayFieldChain } from "../src/services/candidate-processing/candidate-accenture-replay-engine";

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
}
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail?: string) {
  results.push({ name, status: pass ? "PASS" : "FAIL", detail });
}

// --- candidate-excel-date.ts ---
check("serial 46048 -> 2026-01-26 (file's first report date)", accentureReportDateKey("46048") === "2026-01-26");
check("serial 46299 -> 2026-10-04 (file's last report date)", accentureReportDateKey("46299") === "2026-10-04");
check("blank -> null", accentureReportDateKey("") === null);
check("non-numeric -> null", accentureReportDateKey("not-a-date") === null);
{
  const d = parseAccentureReportDate("46048");
  check(
    "noon IST of 2026-01-26 -> 2026-01-26T06:30:00.000Z",
    d !== null && d.toISOString() === "2026-01-26T06:30:00.000Z",
    d?.toISOString()
  );
}
{
  const cutoff = istEndOfDayExclusiveUtc("2026-10-04");
  check(
    "end of 2026-10-04 IST (exclusive) -> 2026-10-04T18:30:00.000Z",
    cutoff.toISOString() === "2026-10-04T18:30:00.000Z",
    cutoff.toISOString()
  );
}

// --- computeAccentureReplayFieldChain ---
const liveWriteAt = new Date("2026-11-01T00:00:00.000Z");
const d = (iso: string) => new Date(iso);

{
  // Blank cells never become a step and never overwrite — occurrences passed in are already pre-filtered
  // to usable-only (this is the caller's job), so this just confirms the walk itself over a clean sequence.
  const r = computeAccentureReplayFieldChain(
    "-",
    [
      { value: "Screen", changedAt: d("2026-01-26T06:30:00Z") },
      { value: "Interview", changedAt: d("2026-02-10T06:30:00Z") },
    ],
    { frozen: false, liveWriteAt }
  );
  check(
    "seed '-' + [Screen, Interview] -> 2 steps, final Interview, wouldWriteLive",
    r.wouldWriteLive &&
      r.finalValue === "Interview" &&
      r.steps.length === 2 &&
      r.steps[0].oldValue === "-" &&
      r.steps[0].newValue === "Screen" &&
      r.steps[1].oldValue === "Screen" &&
      r.steps[1].newValue === "Interview",
    JSON.stringify(r)
  );
}

{
  // Revert case: A -> B -> A. Classic engine's short-circuit would log 0 steps here; replay must log both.
  const r = computeAccentureReplayFieldChain(
    "A",
    [
      { value: "B", changedAt: d("2026-02-10T06:30:00Z") },
      { value: "A", changedAt: d("2026-03-05T06:30:00Z") },
    ],
    { frozen: false, liveWriteAt }
  );
  check(
    "revert A->B->A: BOTH steps logged (no final-equals-seed short-circuit), but wouldWriteLive is false (final===seed)",
    !r.wouldWriteLive &&
      r.finalValue === "A" &&
      r.steps.length === 2 &&
      r.steps[0].oldValue === "A" &&
      r.steps[0].newValue === "B" &&
      r.steps[1].oldValue === "B" &&
      r.steps[1].newValue === "A",
    JSON.stringify(r)
  );
  // Neither step should be re-stamped with liveWriteAt since nothing was actually written live.
  check(
    "revert case: both steps keep their true historical changedAt (no live write happened)",
    r.steps[0].changedAt.getTime() === d("2026-02-10T06:30:00Z").getTime() &&
      r.steps[1].changedAt.getTime() === d("2026-03-05T06:30:00Z").getTime()
  );
}

{
  // Live-write stamping: the LAST step, and only the last step, gets liveWriteAt when wouldWriteLive.
  const r = computeAccentureReplayFieldChain(
    "A",
    [
      { value: "B", changedAt: d("2026-02-10T06:30:00Z") },
      { value: "C", changedAt: d("2026-03-05T06:30:00Z") },
    ],
    { frozen: false, liveWriteAt }
  );
  check(
    "A->B->C, wouldWriteLive: first step keeps its historical date, LAST step is re-stamped with liveWriteAt",
    r.wouldWriteLive &&
      r.steps.length === 2 &&
      r.steps[0].changedAt.getTime() === d("2026-02-10T06:30:00Z").getTime() &&
      r.steps[1].changedAt.getTime() === liveWriteAt.getTime(),
    JSON.stringify(r)
  );
}

{
  // Frozen: history still fully logged, but wouldWriteLive is forced false and NO step gets re-stamped.
  const r = computeAccentureReplayFieldChain(
    "A",
    [{ value: "B", changedAt: d("2026-02-10T06:30:00Z") }],
    { frozen: true, liveWriteAt }
  );
  check(
    "frozen field: step still logged with its true historical date, wouldWriteLive forced false",
    !r.wouldWriteLive &&
      r.steps.length === 1 &&
      r.steps[0].oldValue === "A" &&
      r.steps[0].newValue === "B" &&
      r.steps[0].changedAt.getTime() === d("2026-02-10T06:30:00Z").getTime(),
    JSON.stringify(r)
  );
}

{
  // No occurrences at all (e.g. every occurrence already consumed by an earlier checkpoint) -> true no-op.
  const r = computeAccentureReplayFieldChain("A", [], { frozen: false, liveWriteAt });
  check("no occurrences -> 0 steps, finalValue stays seed, no live write", !r.wouldWriteLive && r.finalValue === "A" && r.steps.length === 0);
}

{
  // Case-insensitive email: a pure capitalization difference is not a step and not a live write...
  const r = computeAccentureReplayFieldChain(
    "jane@example.test",
    [{ value: "Jane@Example.test", changedAt: d("2026-02-10T06:30:00Z") }],
    { frozen: false, liveWriteAt, caseInsensitive: true }
  );
  check(
    "email case-insensitive: pure case difference -> 0 steps, no live write",
    !r.wouldWriteLive && r.steps.length === 0 && r.finalValue === "Jane@Example.test",
    JSON.stringify(r)
  );
}
{
  // ...but the exact-cased value from the file is still what finalValue carries, for when a REAL change does happen.
  const r = computeAccentureReplayFieldChain(
    "jane@example.test",
    [
      { value: "Jane@Example.test", changedAt: d("2026-02-10T06:30:00Z") },
      { value: "john@example.test", changedAt: d("2026-03-05T06:30:00Z") },
    ],
    { frozen: false, liveWriteAt, caseInsensitive: true }
  );
  check(
    "email case-insensitive: case-only step produces no log row; the real change after it logs one step from the last REPORTED casing (Jane@Example.test, not the original seed's jane@example.test) to the new value",
    r.wouldWriteLive &&
      r.steps.length === 1 &&
      r.steps[0].oldValue === "Jane@Example.test" &&
      r.steps[0].newValue === "john@example.test" &&
      r.finalValue === "john@example.test",
    JSON.stringify(r)
  );
}
{
  // Stage comparison is exact (case-sensitive) — no caseInsensitive flag passed.
  const r = computeAccentureReplayFieldChain(
    "screen",
    [{ value: "Screen", changedAt: d("2026-02-10T06:30:00Z") }],
    { frozen: false, liveWriteAt }
  );
  check(
    "non-email field: case difference IS a real step (exact comparison)",
    r.wouldWriteLive && r.steps.length === 1 && r.steps[0].oldValue === "screen" && r.steps[0].newValue === "Screen"
  );
}

console.log("\n========== TEST RESULTS ==========");
let failures = 0;
for (const r of results) {
  console.log(`[${r.status}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  if (r.status === "FAIL") failures += 1;
}
console.log(`\n${results.length - failures}/${results.length} passed.`);
if (failures > 0) process.exitCode = 1;
