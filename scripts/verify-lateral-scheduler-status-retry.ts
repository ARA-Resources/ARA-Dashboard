/**
 * Pure-function test for Release B's new Lateral scheduler-status retry
 * policy (src/hooks/use-lateral-scheduler-status.ts). No network, no DB —
 * exercises `lateralSchedulerStatusRetry` directly against every status
 * class it's meant to distinguish.
 *
 * Policy: retry on a network-level failure (no HTTP status at all) or a
 * 5xx response, up to 2 times; never retry 401 or 403 (a viewer session is
 * always a 403 here — must stay at zero retries); don't retry any other
 * 4xx either.
 *
 * Run: npm run test:lateral-scheduler-status-retry
 */
import {
  lateralSchedulerStatusRetry,
  LateralSchedulerStatusHttpError,
} from "../src/hooks/use-lateral-scheduler-status";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// --- 403 (viewer role): zero retries, ever ---
{
  const err = new LateralSchedulerStatusHttpError("Forbidden", 403);
  assert(lateralSchedulerStatusRetry(1, err) === false, "403 must not retry on failureCount=1");
  assert(lateralSchedulerStatusRetry(2, err) === false, "403 must not retry on failureCount=2");
}

// --- 401: zero retries, ever ---
{
  const err = new LateralSchedulerStatusHttpError("Unauthorized", 401);
  assert(lateralSchedulerStatusRetry(1, err) === false, "401 must not retry");
}

// --- other 4xx (e.g. 404): zero retries ---
{
  const err = new LateralSchedulerStatusHttpError("Not Found", 404);
  assert(lateralSchedulerStatusRetry(1, err) === false, "404 must not retry");
}

// --- 5xx: retries up to 2 times, then stops ---
{
  const err = new LateralSchedulerStatusHttpError("Internal Server Error", 500);
  assert(lateralSchedulerStatusRetry(1, err) === true, "5xx must retry on failureCount=1");
  assert(lateralSchedulerStatusRetry(2, err) === true, "5xx must retry on failureCount=2");
  assert(lateralSchedulerStatusRetry(3, err) === false, "5xx must stop retrying at failureCount=3");
}

// --- network-level failure (fetch() itself rejected — no status at all) ---
{
  const err = new TypeError("Failed to fetch");
  assert(lateralSchedulerStatusRetry(1, err) === true, "network error must retry on failureCount=1");
  assert(lateralSchedulerStatusRetry(2, err) === true, "network error must retry on failureCount=2");
  assert(lateralSchedulerStatusRetry(3, err) === false, "network error must stop retrying at failureCount=3");
}

console.log("verify-lateral-scheduler-status-retry: OK");
