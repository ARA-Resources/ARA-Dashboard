/**
 * Unit test for the two-gate Posted fake-Drive demo check: the env var
 * alone must never be enough, and the marker file alone must never be
 * enough — only both together activate it. No Drive/DB/network I/O.
 */
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const DEMO_FLAG = "ARA_POSTED_FAKE_DRIVE_DEMO";

async function withMarker<T>(exists: boolean, fn: () => Promise<T>): Promise<T> {
  // MARKER_PATH is hardcoded to /opt/ara-posted-demo/ENABLED in the module
  // under test (deliberately not env-configurable) — so this test creates
  // and removes exactly that path rather than a configurable stand-in.
  const markerPath = "/opt/ara-posted-demo/ENABLED";
  const dir = path.dirname(markerPath);
  if (exists) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(markerPath, "test\n");
  } else {
    await fs.rm(markerPath, { force: true });
  }
  try {
    return await fn();
  } finally {
    await fs.rm(markerPath, { force: true });
  }
}

async function main() {
  // Isolate from any real /opt/ara-posted-demo on this host — only safe
  // because this script fully cleans up in `finally` within withMarker().
  const originalFlag = process.env[DEMO_FLAG];

  try {
    // Case 1: neither flag nor marker — inactive.
    delete process.env[DEMO_FLAG];
    await withMarker(false, async () => {
      const { isPostedFakeDriveDemoActive } = await import(
        "../src/services/dataset-posted/posted-fake-drive-demo"
      );
      assert.equal(await isPostedFakeDriveDemoActive(), false, "neither set: must be inactive");
    });

    // Case 2: flag set, marker absent — inactive (flag alone is not enough).
    process.env[DEMO_FLAG] = "1";
    await withMarker(false, async () => {
      const mod = await import("../src/services/dataset-posted/posted-fake-drive-demo");
      assert.equal(await mod.isPostedFakeDriveDemoActive(), false, "flag without marker: must be inactive");
    });

    // Case 3: marker present, flag absent/wrong — inactive (marker alone is not enough).
    delete process.env[DEMO_FLAG];
    await withMarker(true, async () => {
      const mod = await import("../src/services/dataset-posted/posted-fake-drive-demo");
      assert.equal(await mod.isPostedFakeDriveDemoActive(), false, "marker without flag: must be inactive");
    });

    // Case 4: both present — active.
    process.env[DEMO_FLAG] = "1";
    await withMarker(true, async () => {
      const mod = await import("../src/services/dataset-posted/posted-fake-drive-demo");
      assert.equal(await mod.isPostedFakeDriveDemoActive(), true, "both set: must be active");
    });

    console.log("verify-posted-fake-drive-demo-gate: all cases passed");
  } finally {
    if (originalFlag === undefined) delete process.env[DEMO_FLAG];
    else process.env[DEMO_FLAG] = originalFlag;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
