/**
 * Checkpoint 2 verification: validateExcelBuffer's new optional MS-OFFCRYPTO
 * decryption support. Covers the 5 required cases end-to-end against the
 * real function and the real Python helper (scripts/msoffcrypto-decrypt.py)
 * — no mocking of the Python layer.
 *
 * Requires: msoffcrypto-tool + openpyxl installed for python3 (checkpoint 1).
 */
import ExcelJS from "exceljs";
import { validateExcelBuffer } from "../src/services/dataset/validate-excel";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function buildPlainXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Base DS");
  ws.addRow(["Job Requisition ID", "Market"]);
  ws.addRow(["ATCI-TEST-0000001", "APAC"]);
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

async function main() {
  const PASSWORD = "CorrectHorse123";
  const plainBytes = await buildPlainXlsx();

  // Encrypt the plain file via the same python helper's underlying library,
  // through a tiny inline python one-liner (test-only, not the production script).
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const execFileAsync = promisify(execFile);

  const tmpPlain = path.join(os.tmpdir(), `plain-${Date.now()}.xlsx`);
  const tmpEnc = path.join(os.tmpdir(), `enc-${Date.now()}.bin`);
  const tmpCorrupt = path.join(os.tmpdir(), `corrupt-${Date.now()}.xlsx`);
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
    PASSWORD,
  ]);
  const encryptedBytes = await fs.readFile(tmpEnc);

  // A genuinely corrupt (not encrypted, not valid zip) "xlsx" -- random bytes.
  const corruptBytes = Buffer.from("this is not an excel file at all, just text");

  console.log("=== Case 1: normal unencrypted file (zero behavior change) ===");
  {
    const result = await validateExcelBuffer(plainBytes, "test.xlsx");
    assert(result.ok === true, `expected ok:true, got ${JSON.stringify(result)}`);
    assert(result.wasEncrypted === undefined, "unencrypted file must not set wasEncrypted");
    assert(result.decryptedBuffer === undefined, "unencrypted file must not set decryptedBuffer");
    assert(result.errorCode === undefined, "unencrypted file must not set errorCode");
    console.log("PASS: unencrypted file behaves exactly as before.\n");
  }

  console.log("=== Case 2: encrypted file, correct password ===");
  {
    const result = await validateExcelBuffer(encryptedBytes, "test.xlsx", { password: PASSWORD });
    assert(result.ok === true, `expected ok:true, got ${JSON.stringify({ ...result, decryptedBuffer: undefined })}`);
    assert(result.wasEncrypted === true, "must report wasEncrypted:true");
    assert(Buffer.isBuffer(result.decryptedBuffer), "must return decrypted bytes");
    // Confirm the decrypted bytes are actually the correct workbook content.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(result.decryptedBuffer as unknown as Parameters<ExcelJS.Xlsx["load"]>[0]);
    const ws = wb.worksheets[0];
    assert(ws.getCell(2, 1).value === "ATCI-TEST-0000001", "decrypted content must match original");
    console.log("PASS: correct password decrypts and validates successfully.\n");
  }

  console.log("=== Case 3: encrypted file, wrong password ===");
  {
    const result = await validateExcelBuffer(encryptedBytes, "test.xlsx", { password: "totally-wrong" });
    assert(result.ok === false, "wrong password must fail");
    assert(result.errorCode === "ENCRYPTED_WRONG_PASSWORD", `expected ENCRYPTED_WRONG_PASSWORD, got ${result.errorCode}`);
    assert(result.wasEncrypted === true, "must still report wasEncrypted:true");
    console.log("PASS: wrong password fails with a distinct, clear errorCode.\n");
  }

  console.log("=== Case 4: encrypted file, no password configured ===");
  {
    const result = await validateExcelBuffer(encryptedBytes, "test.xlsx");
    assert(result.ok === false, "no password must fail");
    assert(result.errorCode === "ENCRYPTED_NO_PASSWORD", `expected ENCRYPTED_NO_PASSWORD, got ${result.errorCode}`);
    assert(result.wasEncrypted === true, "must still report wasEncrypted:true");
    console.log("PASS: missing password fails with a distinct errorCode, different from wrong-password.\n");
  }

  console.log("=== Case 5: genuinely corrupt file, NOT encrypted (existing behavior, unaffected) ===");
  {
    const result = await validateExcelBuffer(corruptBytes, "test.xlsx");
    assert(result.ok === false, "corrupt file must fail");
    assert(result.errorCode === undefined, "genuinely corrupt file must NOT get an encryption errorCode");
    assert(result.wasEncrypted === undefined, "genuinely corrupt file must NOT be flagged as encrypted");
    assert(
      result.error === "Invalid Open XML Excel signature (expected ZIP/PK header).",
      `expected the original unchanged error text, got: ${result.error}`
    );
    console.log("PASS: genuinely corrupt non-encrypted file keeps its original, unchanged error.\n");
  }

  await fs.rm(tmpPlain, { force: true });
  await fs.rm(tmpEnc, { force: true });
  await fs.rm(tmpCorrupt, { force: true }).catch(() => undefined);

  console.log("=== ALL CHECKPOINT 2 CHECKS PASSED ===");
}

main().catch((err) => {
  console.error("CHECKPOINT 2 VERIFICATION FAILED:", err);
  process.exit(1);
});
