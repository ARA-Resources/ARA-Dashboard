import { createHash } from "node:crypto";
import ExcelJS from "exceljs";

export interface IntegrityResult {
  ok: boolean;
  error?: string;
  checksumSha256?: string;
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Validate Excel attachment bytes before promoting a dataset file.
 * Read-only check — never rewrites the workbook (preserves Excel 365 / macros).
 * Also returns SHA-256 checksum for duplicate / integrity tracking.
 */
export async function validateExcelBuffer(
  buffer: Buffer,
  filename: string
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
