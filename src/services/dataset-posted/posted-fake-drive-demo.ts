/**
 * Demo-only fake Drive provider for the Posted run services — exists so a
 * throwaway container running the REAL app (`next start`) can be clicked
 * through in a browser without real Drive credentials. Feeds the SAME
 * `testHooks` parameter the automated tests use (see `lateral-posted-run.ts`
 * / `executive-posted-run.ts`), rather than adding a second code path.
 *
 * Gate is now TWO independent conditions, both required:
 *   1. ARA_POSTED_FAKE_DRIVE_DEMO must be exactly "1".
 *   2. A marker file must exist at MARKER_PATH, a path FIXED in this file
 *      (not read from any env var) — so setting the env var alone, on a
 *      box that doesn't also have this exact file, is not enough. Only the
 *      demo containers' seed step creates this file.
 * Neither the env var name nor MARKER_PATH is ever set/created anywhere in
 * this repo's Dockerfile, docker-compose.yml, or any default/example env
 * file — grep confirms zero occurrences outside this file and the demo
 * container's own setup. Activating it requires a human deliberately doing
 * both things; there is no legitimate reason either would exist on a real
 * deployment.
 *
 * An earlier version of this gate ALSO refused to activate if any real
 * Drive credential/config env var (GOOGLE_CLIENT_ID,
 * ARA_LATERAL_MASTER_DRIVE_FILE_ID, etc.) was present, on the theory that
 * prod always has them set. That check turned out to be structurally
 * unable to discriminate anything, confirmed empirically while building
 * the Stage 3 demo: `next start` forces production mode internally
 * regardless of NODE_ENV, so `assertProductionConfig()`
 * (`src/instrumentation.node.ts`) requires those same vars to be set —
 * to SOME value, dummy or real — before ANY instance of this app will
 * even boot, demo included. So every booted instance, demo or real, always
 * has them "present"; checking for that presence is always true and
 * refuses every time, which is what first broke this demo. The two-gate
 * check above (env var + marker file, neither derived from the other) is
 * the real guarantee instead.
 *
 * The seed .xlsm files are NOT created by this module or by the app — an
 * operator seeds them into ARA_POSTED_FAKE_DRIVE_DEMO_DIR before starting
 * the demo container (see Stage 3's report for the exact command). If the
 * seed file is missing, this throws a clear error rather than silently
 * creating an empty one.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { drive_v3 } from "googleapis";

const DEMO_FLAG = "ARA_POSTED_FAKE_DRIVE_DEMO";

/** Fixed, not env-configurable — only the demo containers' seed step ever creates this file. */
const MARKER_PATH = "/opt/ara-posted-demo/ENABLED";

export async function isPostedFakeDriveDemoActive(): Promise<boolean> {
  if (process.env[DEMO_FLAG] !== "1") return false;
  try {
    await fs.access(MARKER_PATH);
    return true;
  } catch {
    return false;
  }
}

let bootWarningLogged = false;

/**
 * Called once from instrumentation.node.ts at process boot. Silent (and
 * cheap) when the demo gate is inactive — this never affects a real boot.
 */
export async function logPostedFakeDriveDemoBootWarningOnce(): Promise<void> {
  if (bootWarningLogged) return;
  bootWarningLogged = true;
  const active = await isPostedFakeDriveDemoActive();
  if (!active) return;
  console.warn(
    "=".repeat(70) +
      "\n[posted-fake-drive-demo] ARA_POSTED_FAKE_DRIVE_DEMO is ACTIVE — " +
      "the Posted button's Drive calls on this instance are FAKE " +
      `(marker file present at ${MARKER_PATH}). This must never be true ` +
      "on a real deployment.\n" +
      "=".repeat(70)
  );
}

function demoDir(): string {
  return process.env.ARA_POSTED_FAKE_DRIVE_DEMO_DIR?.trim() || "/tmp/posted-demo-drive";
}

function buildDemoDrive(fileId: string, fileName: string, bytesPath: string): drive_v3.Drive {
  let modifiedTime = new Date().toISOString();
  let revision = 1;

  return {
    files: {
      get: async (params: { fileId?: string; alt?: string }) => {
        if (params.fileId !== fileId) {
          throw Object.assign(new Error("File not found"), { status: 404 });
        }
        if (params.alt === "media") {
          const bytes = await fs.readFile(bytesPath);
          return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
        }
        return { data: { id: fileId, name: fileName, mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12", trashed: false, modifiedTime, headRevisionId: String(revision) } };
      },
      update: async (params: { fileId?: string; media?: { body?: AsyncIterable<Buffer> } }) => {
        if (params.fileId !== fileId) {
          throw Object.assign(new Error("File not found"), { status: 404 });
        }
        const body = params.media?.body;
        if (!body) throw new Error("Demo fake Drive update called with no media body.");
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        await fs.writeFile(bytesPath, Buffer.concat(chunks));
        revision += 1;
        modifiedTime = new Date().toISOString();
        return { data: { id: fileId, name: fileName, modifiedTime } };
      },
    },
  } as unknown as drive_v3.Drive;
}

export interface LateralDemoHooks {
  drive: drive_v3.Drive;
  fileId: string;
  fileName: string;
  masterSheet: string;
  postedSheet: string;
}

export async function buildLateralDemoHooks(): Promise<LateralDemoHooks> {
  const fileId = "demo-lateral-workbook";
  const fileName = "Demo Lateral Master.xlsm";
  const bytesPath = path.join(demoDir(), `${fileId}.bin`);
  await fs.access(bytesPath); // throws a clear error if the operator forgot to seed it
  return { drive: buildDemoDrive(fileId, fileName, bytesPath), fileId, fileName, masterSheet: "Master Sheet", postedSheet: "Posted Sheet" };
}

export interface ExecutiveDemoHooks {
  drive: drive_v3.Drive;
  fileId: string;
}

export async function buildExecutiveDemoHooks(): Promise<ExecutiveDemoHooks> {
  const fileId = "demo-executive-workbook";
  const fileName = "Demo Executive Master.xlsm";
  const bytesPath = path.join(demoDir(), `${fileId}.bin`);
  await fs.access(bytesPath);
  return { drive: buildDemoDrive(fileId, fileName, bytesPath), fileId };
}
