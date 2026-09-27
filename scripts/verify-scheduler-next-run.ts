/**
 * Verifies `estimateNextRun` / `estimateNextRunFromExpressions` return the
 * real next firing instant in the schedule's timezone, independent of the
 * process's own `TZ`. The old implementation labelled Asia/Kolkata wall-clock
 * as UTC, so the UI showed every "Next Run" 5h30m late (07:30 → 1:00 pm).
 *
 * Run under several process timezones — the result must be identical:
 *   TZ=UTC              npm run test:scheduler-next-run
 *   TZ=America/New_York npm run test:scheduler-next-run
 *
 * Pure date-math + node-cron; no DB, Gmail, or Drive needed.
 */
import cron from "node-cron";
import {
  buildCronExpressionsFromSchedule,
  estimateNextRun,
  estimateNextRunFromExpressions,
} from "../src/services/dataset/scheduler";

const TIMEZONE = "Asia/Kolkata";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function wallClock(ms: number): { weekday: string; hhmm: string } {
  const parts = partsFormatter.formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return { weekday: get("weekday"), hhmm: `${get("hour")}:${get("minute")}` };
}

/**
 * Independent oracle: walk forward minute by minute from "now" and return
 * the first instant whose Asia/Kolkata wall-clock matches. Does not reuse
 * node-cron or any scheduler code.
 */
function bruteForceNext(weekdays: string[], times: string[]): number {
  const start = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
  for (let ms = start; ms < start + 8 * 24 * 60 * 60_000; ms += 60_000) {
    const { weekday, hhmm } = wallClock(ms);
    if (weekdays.includes(weekday) && times.includes(hhmm)) return ms;
  }
  throw new Error("oracle found no match within 8 days");
}

console.log(
  `Process TZ=${process.env.TZ ?? "(unset)"} resolved=${Intl.DateTimeFormat().resolvedOptions().timeZone}`
);

// 1. Target schedule: Mon–Fri 10:00, 11:00, 12:00, 13:00, 14:00 Asia/Kolkata,
//    built through the same path the Lateral/Executive schedulers use.
const MON_FRI = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const TARGET_TIMES = ["10:00", "11:00", "12:00", "13:00", "14:00"];
const expressions = buildCronExpressionsFromSchedule({
  frequency: "custom",
  syncTime: "10:00",
  dayOfWeek: 1,
  customDays: [1, 2, 3, 4, 5],
  customTimes: TARGET_TIMES,
});
assert(expressions.length === 5, `expected 5 expressions, got ${expressions.length}`);
assert(
  expressions[0] === "0 10 * * 1,2,3,4,5",
  `unexpected first expression ${expressions[0]}`
);

const next = estimateNextRunFromExpressions(expressions, TIMEZONE);
assert(next !== null, "target schedule returned null");
const nextMs = Date.parse(next!);
const expectedMs = bruteForceNext(MON_FRI, TARGET_TIMES);
assert(
  nextMs === expectedMs,
  `target schedule: got ${next}, oracle says ${new Date(expectedMs).toISOString()}`
);
const wc = wallClock(nextMs);
assert(MON_FRI.includes(wc.weekday), `next run on ${wc.weekday}, expected Mon–Fri`);
assert(TARGET_TIMES.includes(wc.hhmm), `next run at ${wc.hhmm} IST, expected a target time`);
assert(nextMs > Date.now(), "next run is not in the future");
console.log(
  `PASS: Mon–Fri 10:00…14:00 IST → ${next} (${wc.weekday} ${wc.hhmm} IST), matches oracle`
);

// 2. Each individual expression also matches the oracle (not just the earliest).
for (const [index, expression] of expressions.entries()) {
  const single = estimateNextRun(expression, TIMEZONE);
  const oracle = bruteForceNext(MON_FRI, [TARGET_TIMES[index]]);
  assert(
    single !== null && Date.parse(single) === oracle,
    `${expression}: got ${single}, oracle ${new Date(oracle).toISOString()}`
  );
}
console.log("PASS: each of the 5 expressions matches the oracle individually");

// 3. The 5h30m regression: the old code returned IST wall-clock labelled as
//    UTC, i.e. a UTC ISO string whose HH:MM equals a target IST time.
const utcHhmm = next!.slice(11, 16);
assert(
  !TARGET_TIMES.includes(utcHhmm),
  `UTC ISO ${next} carries the IST wall-clock time — the +5:30 display bug is back`
);
console.log(`PASS: ISO is a real UTC instant (UTC ${utcHhmm}), not IST mislabelled`);

// 4. Daily 07:00 (frequency "daily" path).
const daily = buildCronExpressionsFromSchedule({
  frequency: "daily",
  syncTime: "07:00",
  dayOfWeek: 1,
  customDays: [],
  customTimes: [],
});
const dailyNext = estimateNextRunFromExpressions(daily, TIMEZONE);
const dailyOracle = bruteForceNext(
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  ["07:00"]
);
assert(
  dailyNext !== null && Date.parse(dailyNext) === dailyOracle,
  `daily 07:00: got ${dailyNext}, oracle ${new Date(dailyOracle).toISOString()}`
);
console.log(`PASS: daily 07:00 IST → ${dailyNext}`);

// 5. Invalid expression → null, not a throw.
assert(estimateNextRun("not a cron", TIMEZONE) === null, "invalid expression should return null");
console.log("PASS: invalid expression returns null");

// 6. No leak into node-cron's global task registry.
const before = cron.getTasks().size;
for (let i = 0; i < 100; i += 1) {
  estimateNextRunFromExpressions(expressions, TIMEZONE);
}
const after = cron.getTasks().size;
assert(after === before, `node-cron registry grew from ${before} to ${after}`);
console.log(`PASS: node-cron registry unchanged after 500 estimates (${after} tasks)`);

console.log("\nALL CHECKS PASSED");
