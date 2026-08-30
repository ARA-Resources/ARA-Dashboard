import ExcelJS from "exceljs";
import { validateExcelBuffer } from "@/services/dataset/validate-excel";
import { EXECUTIVE_REQUIRED_SHEETS } from "@/services/dataset/executive-ingestion-config";

export interface ExecutiveWorkbookValidationResult {
  ok: boolean;
  error?: string;
  checksumSha256?: string;
  sheetNames?: string[];
  missingSheets?: string[];
  extensionOk?: boolean;
  sizeBytes?: number;
}

const MAX_ATTACHMENT_BYTES = 80 * 1024 * 1024; // 80 MiB safety cap

/**
 * Validate an Executive source attachment (Phase 4A).
 * Read-only — never writes or executes VBA.
 */
export async function validateExecutiveXlsmBuffer(
  buffer: Buffer,
  filename: string,
  options?: { mimeType?: string }
): Promise<ExecutiveWorkbookValidationResult> {
  const sizeBytes = buffer?.length ?? 0;
  const lower = (filename || "").toLowerCase();
  const extensionOk = lower.endsWith(".xlsm");

  if (!extensionOk) {
    return {
      ok: false,
      error: "Executive source must be an .xlsm workbook.",
      extensionOk: false,
      sizeBytes,
    };
  }

  if (sizeBytes <= 0) {
    return { ok: false, error: "Empty attachment payload.", sizeBytes };
  }

  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: "Attachment exceeds the Executive size safety limit.",
      sizeBytes,
    };
  }

  const mime = (options?.mimeType ?? "").toLowerCase();
  if (
    mime &&
    !mime.includes("spreadsheet") &&
    !mime.includes("excel") &&
    !mime.includes("octet-stream") &&
    !mime.includes("zip") &&
    !mime.includes("macro")
  ) {
    // Soft warning only — Gmail MIME is often unreliable; integrity check decides.
  }

  const base = await validateExcelBuffer(buffer, filename);
  if (!base.ok) {
    return {
      ok: false,
      error: base.error ?? "Excel integrity check failed.",
      checksumSha256: base.checksumSha256,
      extensionOk: true,
      sizeBytes,
    };
  }

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      Buffer.from(buffer) as unknown as Parameters<ExcelJS.Xlsx["load"]>[0]
    );
    const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
    const byLower = new Set(sheetNames.map((name) => name.trim().toLowerCase()));
    const missingSheets = EXECUTIVE_REQUIRED_SHEETS.filter(
      (required) => !byLower.has(required.toLowerCase())
    );

    if (missingSheets.length > 0) {
      return {
        ok: false,
        error: `Executive workbook is missing required sheets: ${missingSheets.join(", ")}`,
        checksumSha256: base.checksumSha256,
        sheetNames,
        missingSheets: [...missingSheets],
        extensionOk: true,
        sizeBytes,
      };
    }

    return {
      ok: true,
      checksumSha256: base.checksumSha256,
      sheetNames,
      missingSheets: [],
      extensionOk: true,
      sizeBytes,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `Executive workbook sheet validation failed: ${error.message}`
          : "Executive workbook sheet validation failed.",
      checksumSha256: base.checksumSha256,
      extensionOk: true,
      sizeBytes,
    };
  }
}

export function matchesExecutiveAttachmentPattern(
  filename: string,
  pattern: string
): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return true;
  const name = filename || "";

  if (trimmed.startsWith("/") && trimmed.lastIndexOf("/") > 0) {
    const last = trimmed.lastIndexOf("/");
    const body = trimmed.slice(1, last);
    const flags = trimmed.slice(last + 1) || "i";
    try {
      return new RegExp(body, flags).test(name);
    } catch {
      return false;
    }
  }

  return name.toLowerCase().includes(trimmed.toLowerCase());
}
