/**
 * Confirms logPostedFakeDriveDemoBootWarningOnce() does the right thing on
 * both sides of the double gate: silent (no console.warn at all) when
 * inactive, loud exactly once when active — even across repeat calls in the
 * same process (the "only warn once" flag is module-scoped, matching a real
 * process that only boots once).
 *
 * Each case runs in its own child process (`tsx` invoked fresh) rather than
 * re-importing the module in-process — module-level state like
 * `bootWarningLogged` persists for the life of a module instance, and nudging
 * Node's loader into giving a "fresh" instance via cache-busting tricks
 * proved unreliable; a real child process is both simpler and more faithful
 * to how this function is actually used (once, at real process boot).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);

const DEMO_FLAG = "ARA_POSTED_FAKE_DRIVE_DEMO";
const MARKER_PATH = "/opt/ara-posted-demo/ENABLED";

const CHILD_SCRIPT = `
import * as mod from "__IMPORT_PATH__";
async function main() {
  const calls: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { calls.push(args); };
  await mod.logPostedFakeDriveDemoBootWarningOnce();
  // A second call (e.g. a second instrumentation pass) must not log again.
  await mod.logPostedFakeDriveDemoBootWarningOnce();
  console.warn = originalWarn;
  process.stdout.write(JSON.stringify({ count: calls.length, text: String(calls[0]?.[0] ?? "") }));
}
main();
`;

async function runChildCase(markerExists: boolean, flagSet: boolean): Promise<{ count: number; text: string }> {
  const dir = path.dirname(MARKER_PATH);
  if (markerExists) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(MARKER_PATH, "test\n");
  } else {
    await fs.rm(MARKER_PATH, { force: true });
  }

  const childPath = path.join(process.cwd(), ".posted-boot-warning-child.ts");
  const realImportPath = path.join(process.cwd(), "src/services/dataset-posted/posted-fake-drive-demo.ts");
  const script = CHILD_SCRIPT.replace("__IMPORT_PATH__", realImportPath.replace(/\\/g, "/"));
  await fs.writeFile(childPath, script);
  try {
    const env = { ...process.env };
    if (flagSet) env[DEMO_FLAG] = "1";
    else delete env[DEMO_FLAG];
    const { stdout } = await execFileAsync("npx", ["tsx", childPath], { env, cwd: process.cwd() });
    return JSON.parse(stdout.trim());
  } finally {
    await fs.rm(childPath, { force: true });
    await fs.rm(MARKER_PATH, { force: true });
  }
}

async function main() {
  const inactive = await runChildCase(false, false);
  assert.equal(inactive.count, 0, "inactive gate: console.warn must not be called");

  const active = await runChildCase(true, true);
  assert.equal(active.count, 1, "active gate: console.warn must be called exactly once, even across repeat calls");
  assert.match(active.text, /ACTIVE/, "warning text must say the gate is ACTIVE");
  assert.ok(active.text.includes(MARKER_PATH), "warning text must name the marker path");

  console.log("verify-posted-boot-warning: both cases passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
