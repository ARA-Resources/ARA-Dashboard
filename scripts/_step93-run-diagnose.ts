import { config } from "dotenv";
config({ path: ".env.local" });
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";

const execFileAsync = promisify(execFile);
const ID = "1ztfWeVhDyzYOHlvA8ujzvtSapRDvvPw9";

async function main() {
  const { drive } = await getAuthorizedGmailClient();
  const dest = path.join(os.tmpdir(), "step93-diagnose.xlsm");
  const media = await drive.files.get(
    { fileId: ID, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(dest, Buffer.from(media.data as ArrayBuffer));
  console.log("downloaded", dest, (await fs.stat(dest)).size);
  const { stdout, stderr } = await execFileAsync(
    "python",
    ["scripts/_step93-diagnose-p-roles.py", dest],
    { windowsHide: true, timeout: 180000, maxBuffer: 32 * 1024 * 1024 }
  );
  if (stderr) console.error(stderr);
  console.log(stdout);
}

void main();
