/**
 * Fake Drive for Posted-button tests. Lives ONLY under scripts/fixtures —
 * not under src/, not imported by any route, page, or component, so the
 * Next.js build (which only bundles src/) can never pull this into the
 * running app no matter what env vars are set. That physical unreachability
 * is the primary guarantee prod can never use it.
 *
 * As defense in depth on top of that, `assertFakeDriveSafeToUse()` is also
 * called every time this is constructed, and independently refuses to run
 * unless an explicit, never-set-in-prod flag is on AND no real Drive
 * credential/config env var is present.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { drive_v3 } from "googleapis";

export const FAKE_DRIVE_ENV_FLAG = "ARA_POSTED_FAKE_DRIVE";

const REAL_CRED_ENV_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "ARA_LATERAL_MASTER_DRIVE_FILE_ID",
  "ARA_EXECUTIVE_MASTER_DRIVE_FILE_ID",
  "ARA_EXECUTIVE_POSTED_SHEET_FILE_ID",
];

export function assertFakeDriveSafeToUse(): void {
  if (process.env[FAKE_DRIVE_ENV_FLAG] !== "1") {
    throw new Error(
      `Fake Drive is disabled — set ${FAKE_DRIVE_ENV_FLAG}=1 to use it. This module is never imported by anything under src/, so no prod code path can reach it regardless of env vars; this check is a second, independent guard.`
    );
  }
  for (const name of REAL_CRED_ENV_VARS) {
    const value = process.env[name];
    if (value && value.trim() !== "") {
      throw new Error(`Refusing to start the fake Drive: real credential/config env var "${name}" is set in this environment.`);
    }
  }
}

interface FakeFileState {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  headRevisionId: string;
  localBytesPath: string;
}

export interface FakeDriveController {
  drive: drive_v3.Drive;
  failNextDownload(message?: string): void;
  failNextUpload(message?: string): void;
  /** Simulate someone else editing the live file between download and upload. */
  touchExternally(): void;
  readCurrentBytes(): Promise<Buffer>;
}

export async function createFakeDrive(options: {
  folder: string;
  fileId: string;
  fileName: string;
  seedLocalXlsmPath: string;
}): Promise<FakeDriveController> {
  assertFakeDriveSafeToUse();
  await fs.mkdir(options.folder, { recursive: true });
  const bytesPath = path.join(options.folder, `${options.fileId}.bin`);
  await fs.copyFile(options.seedLocalXlsmPath, bytesPath);

  let revisionCounter = 1;
  const state: FakeFileState = {
    id: options.fileId,
    name: options.fileName,
    mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12",
    modifiedTime: new Date().toISOString(),
    headRevisionId: String(revisionCounter),
    localBytesPath: bytesPath,
  };

  const pendingDownloadFailures: string[] = [];
  const pendingUploadFailures: string[] = [];

  function notFound(): never {
    throw Object.assign(new Error("File not found"), { status: 404 });
  }

  const fakeDrive = {
    files: {
      get: async (params: { fileId?: string; alt?: string }, _config?: unknown) => {
        if (params.fileId !== state.id) notFound();
        if (params.alt === "media") {
          const msg = pendingDownloadFailures.shift();
          if (msg) {
            throw Object.assign(new Error(msg), { status: 503 });
          }
          const bytes = await fs.readFile(state.localBytesPath);
          return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
        }
        return {
          data: {
            id: state.id,
            name: state.name,
            mimeType: state.mimeType,
            trashed: false,
            modifiedTime: state.modifiedTime,
            headRevisionId: state.headRevisionId,
          },
        };
      },
      update: async (params: { fileId?: string; media?: { body?: AsyncIterable<Buffer> } }) => {
        if (params.fileId !== state.id) notFound();
        // A real HTTP client always reads the request body to send it, whether
        // the server ends up accepting or rejecting the upload — consume the
        // stream BEFORE deciding success/failure, so an injected failure never
        // leaves an unconsumed ReadStream's lazy file-open racing the caller's
        // later cleanup (which is exactly what an unrealistic "fail without
        // reading" fake would do, and did, until this fix).
        const body = params.media?.body;
        if (!body) throw new Error("Fake Drive update called with no media body.");
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));

        const msg = pendingUploadFailures.shift();
        if (msg) {
          throw Object.assign(new Error(msg), { status: 503 });
        }
        await fs.writeFile(state.localBytesPath, Buffer.concat(chunks));
        revisionCounter += 1;
        state.modifiedTime = new Date().toISOString();
        state.headRevisionId = String(revisionCounter);
        return { data: { id: state.id, name: state.name, mimeType: state.mimeType, modifiedTime: state.modifiedTime } };
      },
    },
  } as unknown as drive_v3.Drive;

  return {
    drive: fakeDrive,
    failNextDownload(message = "Simulated download failure") {
      pendingDownloadFailures.push(message);
    },
    failNextUpload(message = "Simulated upload failure") {
      pendingUploadFailures.push(message);
    },
    touchExternally() {
      revisionCounter += 1;
      state.modifiedTime = new Date().toISOString();
      state.headRevisionId = String(revisionCounter);
    },
    async readCurrentBytes() {
      return fs.readFile(state.localBytesPath);
    },
  };
}
