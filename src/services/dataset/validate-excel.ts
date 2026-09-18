import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";

const execFileAsync = promisify(execFile);

const MSOFFCRYPTO_PY = path.join(
  process.cwd(),
  "scripts",
  "msoffcrypto-decrypt.py"
);

export interface IntegrityResult {
  ok: boolean;
  error?: string;
  /** Set only for the password-encryption cases; lets callers give a precise, business-unit-specific message instead of matching error text. */
  errorCode?: "ENCRYPTED_NO_PASSWORD" | "ENCRYPTED_WRONG_PASSWORD";
  checksumSha256?: string;
  /** Set only when a password-encrypted file was successfully decrypted — the decrypted plain-OOXML bytes, for callers to use downstream instead of the original (still-encrypted) buffer. */
  decryptedBuffer?: Buffer;
  /** True whenever the source file was detected as password-encrypted, regardless of whether decryption succeeded. */
  wasEncrypted?: boolean;
}

export interface ValidateExcelOptions {
  /** Decryption password for MS-OFFCRYPTO password-protected files. Omit for the normal unencrypted case. */
  password?: string;
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function withTempFile<T>(
  buffer: Buffer,
  suffix: string,
  fn: (tempPath: string) => Promise<T>
): Promise<T> {
  const tempPath = path.join(
    os.tmpdir(),
    `msoffcrypto-${Date.now()}-${Math.random().toString(16).slice(2)}${suffix}`
  );
  await fs.writeFile(tempPath, buffer);
  try {
    return await fn(tempPath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

/** Detect MS-OFFCRYPTO encryption via the internal CFB directory (EncryptedPackage/EncryptionInfo streams), not just the outer OLE2 signature. */
async function isMsOffCryptoEncrypted(buffer: Buffer): Promise<boolean> {
  return withTempFile(buffer, ".bin", async (inputPath) => {
    const { stdout } = await execFileAsync(
      "python3",
      [MSOFFCRYPTO_PY, "inspect", inputPath],
      { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout.trim()) as {
      ok: boolean;
      encrypted?: boolean;
      error?: string;
    };
    if (!parsed.ok) {
      throw new Error(parsed.error || "msoffcrypto inspect failed");
    }
    return parsed.encrypted === true;
  });
}

/** Decrypt an MS-OFFCRYPTO password-protected file. Returns the decrypted plain-OOXML bytes, or a distinct wrong-password failure. */
async function decryptMsOffCrypto(
  buffer: Buffer,
  password: string
): Promise<{ ok: true; buffer: Buffer } | { ok: false; wrongPassword: boolean; error: string }> {
  return withTempFile(buffer, ".bin", async (inputPath) => {
    const outputPath = `${inputPath}.decrypted.xlsx`;
    try {
      const { stdout } = await execFileAsync(
        "python3",
        [MSOFFCRYPTO_PY, "decrypt", inputPath, outputPath],
        {
          windowsHide: true,
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, ARA_EXCEL_DECRYPT_PASSWORD: password },
        }
      );
      const parsed = JSON.parse(stdout.trim()) as {
        ok: boolean;
        errorCode?: string;
        error?: string;
      };
      if (!parsed.ok) {
        return {
          ok: false,
          wrongPassword: parsed.errorCode === "WRONG_PASSWORD",
          error: parsed.error || "msoffcrypto decrypt failed",
        };
      }
      const decrypted = await fs.readFile(outputPath);
      return { ok: true, buffer: decrypted };
    } finally {
      await fs.rm(outputPath, { force: true });
    }
  });
}

/**
 * Validate Excel attachment bytes before promoting a dataset file.
 * Read-only check — never rewrites the workbook (preserves Excel 365 / macros).
 * Also returns SHA-256 checksum for duplicate / integrity tracking.
 */
export async function validateExcelBuffer(
  buffer: Buffer,
  filename: string,
  options?: ValidateExcelOptions
): Promise<IntegrityResult> {
  const checksumSha256 = sha256Buffer(buffer);

  if (!buffer || buffer.length === 0) {
    return { ok: false, error: "Empty attachment payload.", checksumSha256 };
  }

  if (buffer.length < 8) {
    return {
      ok: false,
      error: "Attachment too small to be a valid Excel file.",
      checksumSha256,
    };
  }

  const lower = filename.toLowerCase();
  const isZipExcel = lower.endsWith(".xlsx") || lower.endsWith(".xlsm");
  const isLegacyXls =
    lower.endsWith(".xls") &&
    !lower.endsWith(".xlsx") &&
    !lower.endsWith(".xlsm");

  if (isZipExcel) {
    if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
      const looksLikeOle2 =
        buffer[0] === 0xd0 &&
        buffer[1] === 0xcf &&
        buffer[2] === 0x11 &&
        buffer[3] === 0xe0;

      if (looksLikeOle2 && (await isMsOffCryptoEncrypted(buffer))) {
        if (!options?.password) {
          return {
            ok: false,
            errorCode: "ENCRYPTED_NO_PASSWORD",
            error:
              "This file is password-protected (MS-OFFCRYPTO) but no decryption password was configured.",
            checksumSha256,
            wasEncrypted: true,
          };
        }

        const decrypted = await decryptMsOffCrypto(buffer, options.password);
        if (!decrypted.ok) {
          return {
            ok: false,
            errorCode: "ENCRYPTED_WRONG_PASSWORD",
            error: decrypted.wrongPassword
              ? "This file is password-protected and the configured password did not decrypt it."
              : `Password-protected Excel file could not be decrypted: ${decrypted.error}`,
            checksumSha256,
            wasEncrypted: true,
          };
        }

        const inner = await validateExcelBuffer(decrypted.buffer, filename);
        if (!inner.ok) {
          return { ...inner, checksumSha256, wasEncrypted: true };
        }
        return {
          ok: true,
          checksumSha256,
          wasEncrypted: true,
          decryptedBuffer: decrypted.buffer,
        };
      }

      // Not encrypted (or not even a CFB file) -- genuinely wrong/corrupt format.
      return {
        ok: false,
        error: "Invalid Open XML Excel signature (expected ZIP/PK header).",
        checksumSha256,
      };
    }

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(
        Buffer.from(buffer) as unknown as Parameters<ExcelJS.Xlsx["load"]>[0]
      );
      const sheets = workbook.worksheets.length;
      if (sheets <= 0) {
        return {
          ok: false,
          error: "Excel workbook has no worksheets.",
          checksumSha256,
        };
      }
      return { ok: true, checksumSha256 };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? `Excel integrity check failed: ${error.message}`
            : "Excel integrity check failed.",
        checksumSha256,
      };
    }
  }

  if (isLegacyXls) {
    const ole =
      buffer[0] === 0xd0 &&
      buffer[1] === 0xcf &&
      buffer[2] === 0x11 &&
      buffer[3] === 0xe0;
    if (!ole) {
      return {
        ok: false,
        error: "Invalid legacy .xls signature (expected OLE compound file).",
        checksumSha256,
      };
    }
    return { ok: true, checksumSha256 };
  }

  return {
    ok: false,
    error: "Unsupported file type for dataset sync validation.",
    checksumSha256,
  };
}
