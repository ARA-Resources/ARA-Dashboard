/** Verify the Posted-button Drive retry classifier and retry wrapper (no network). */
import { isRetryablePostedDriveError, withPostedDriveRetry } from "../src/services/dataset-posted/posted-drive-retry";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function main() {
  // --- classification ---
  assert(isRetryablePostedDriveError({ status: 429 }) === true, "429 must be retryable");
  assert(isRetryablePostedDriveError({ status: 500 }) === true, "500 must be retryable");
  assert(isRetryablePostedDriveError({ response: { status: 503 } }) === true, "503 via response.status must be retryable");
  assert(isRetryablePostedDriveError({ code: "ETIMEDOUT" }) === true, "ETIMEDOUT must be retryable");
  assert(isRetryablePostedDriveError({ status: 404 }) === false, "404 must NOT be retryable");
  assert(isRetryablePostedDriveError({ status: 400 }) === false, "400 must NOT be retryable");
  assert(isRetryablePostedDriveError(new Error("modifiedTime mismatch")) === false, "a plain Error with no status/code must NOT be retryable");
  assert(isRetryablePostedDriveError(null) === false, "null must NOT be retryable");

  // --- wrapper: succeeds first try ---
  {
    let calls = 0;
    const result = await withPostedDriveRetry(
      async () => {
        calls += 1;
        return "ok";
      },
      "test",
      1
    );
    assert(result === "ok" && calls === 1, "a successful first call must not retry");
  }

  // --- wrapper: retryable failure then success ---
  {
    let calls = 0;
    const result = await withPostedDriveRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw { status: 503 };
        return "ok-second-try";
      },
      "test",
      1
    );
    assert(result === "ok-second-try" && calls === 2, `expected exactly one retry, got ${calls} calls`);
  }

  // --- wrapper: non-retryable failure throws immediately, no retry ---
  {
    let calls = 0;
    let threw = false;
    try {
      await withPostedDriveRetry(
        async () => {
          calls += 1;
          throw { status: 404 };
        },
        "test",
        1
      );
    } catch {
      threw = true;
    }
    assert(threw && calls === 1, "a non-retryable error must throw immediately with no retry");
  }

  // --- wrapper: retryable failure twice -> throws after exactly one retry (never more) ---
  {
    let calls = 0;
    let threw = false;
    try {
      await withPostedDriveRetry(
        async () => {
          calls += 1;
          throw { status: 500 };
        },
        "test",
        1
      );
    } catch {
      threw = true;
    }
    assert(threw && calls === 2, `expected exactly one retry attempt (2 calls total), got ${calls}`);
  }

  console.log("verify-posted-drive-retry: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
