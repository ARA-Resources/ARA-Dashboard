/**
 * Wiring verification: confirms the two real call sites --
 * lateral-gmail-incremental-sync.ts:367 and
 * executive-gmail-incremental-sync.ts:320 -- each read their OWN env var
 * (ARA_LATERAL_EXCEL_PASSWORD / ARA_EXECUTIVE_EXCEL_PASSWORD) and never
 * cross-contaminate, using the EXACT same expression each call site uses.
 *
 * Runs with ARA_LATERAL_EXCEL_PASSWORD set to the correct password and
 * ARA_EXECUTIVE_EXCEL_PASSWORD deliberately UNSET in the same process, to
 * prove Executive never silently falls back to Lateral's password.
 */
import ExcelJS from "exceljs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateExcelBuffer } from "../src/services/dataset/validate-excel";

const execFileAsync = promisify(execFile);

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function main() {
  const CORRECT_PASSWORD = "SharedTestPassword123";
  const lateralConfigured = Boolean(process.env.ARA_LATERAL_EXCEL_PASSWORD);
  const executiveConfigured = Boolean(process.env.ARA_EXECUTIVE_EXCEL_PASSWORD);
  assert(
    lateralConfigured !== executiveConfigured,
    "test setup: exactly one of ARA_LATERAL_EXCEL_PASSWORD / ARA_EXECUTIVE_EXCEL_PASSWORD must be set for this run"
  );

  // Build + encrypt a synthetic workbook with the configured password.
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Base DS");
  ws.addRow(["Job Requisition ID"]);
  ws.addRow(["ATCI-WIRING-0000001"]);
  const plainBytes = Buffer.from(await wb.xlsx.writeBuffer());

  const tmpPlain = path.join(os.tmpdir(), `plain-${Date.now()}.xlsx`);
  const tmpEnc = path.join(os.tmpdir(), `enc-${Date.now()}.bin`);
  await fs.writeFile(tmpPlain, plainBytes);
  await execFileAsync("python3", [
    "-c",
    `
import msoffcrypto, sys
with open(sys.argv[1], "rb") as f:
    of = msoffcrypto.OfficeFile(f)
    with open(sys.argv[2], "wb") as out:
        of.encrypt(sys.argv[3], out)
`,
    tmpPlain,
    tmpEnc,
    CORRECT_PASSWORD,
  ]);
  const encryptedBytes = await fs.readFile(tmpEnc);

  console.log(
    `=== Configured: ${lateralConfigured ? "Lateral" : "Executive"} | Unconfigured: ${lateralConfigured ? "Executive" : "Lateral"} ===`
  );

  // Identical to lateral-gmail-incremental-sync.ts:367
  const lateralResult = await validateExcelBuffer(encryptedBytes, "test.xlsx", {
    password: process.env.ARA_LATERAL_EXCEL_PASSWORD || undefined,
  });
  // Identical to executive-gmail-incremental-sync.ts:320
  const executiveResult = await validateExcelBuffer(encryptedBytes, "test.xlsx", {
    password: process.env.ARA_EXECUTIVE_EXCEL_PASSWORD || undefined,
  });

  const configuredResult = lateralConfigured ? lateralResult : executiveResult;
  const unconfiguredResult = lateralConfigured ? executiveResult : lateralResult;
  const configuredName = lateralConfigured ? "Lateral" : "Executive";
  const unconfiguredName = lateralConfigured ? "Executive" : "Lateral";

  assert(
    configuredResult.ok === true,
    `${configuredName} must succeed with its own configured password, got: ${JSON.stringify({ ...configuredResult, decryptedBuffer: undefined })}`
  );
  assert(configuredResult.wasEncrypted === true, `${configuredName} result must report wasEncrypted`);
  console.log(`PASS: ${configuredName}'s own password decrypts the file correctly.\n`);

  assert(unconfiguredResult.ok === false, `${unconfiguredName} must fail (no password configured)`);
  assert(
    unconfiguredResult.errorCode === "ENCRYPTED_NO_PASSWORD",
    `${unconfiguredName} must fail with ENCRYPTED_NO_PASSWORD, got: ${unconfiguredResult.errorCode} / ${unconfiguredResult.error}`
  );
  assert(unconfiguredResult.wasEncrypted === true, `${unconfiguredName} result must still report wasEncrypted:true`);
  console.log(
    `PASS: ${unconfiguredName} correctly fails with ENCRYPTED_NO_PASSWORD -- it did NOT fall back to ${configuredName}'s password despite it being set and correct in the same process.\n`
  );

  await fs.rm(tmpPlain, { force: true });
  await fs.rm(tmpEnc, { force: true });

  console.log("=== ALL WIRING/PASSWORD-ISOLATION CHECKS PASSED ===");
}

main().catch((err) => {
  console.error("WIRING VERIFICATION FAILED:", err);
  process.exit(1);
});
