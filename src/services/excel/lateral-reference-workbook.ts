import fs from "node:fs/promises";
import path from "node:path";
import {
  getBundledLateralExcelPath,
  getLateralExcelPath,
} from "@/lib/config/runtime";

export function resolveLateralReferenceWorkbookPath(): string {
  const fromEnv = getLateralExcelPath();
  if (fromEnv) return fromEnv;
  return getBundledLateralExcelPath();
}

export async function statLateralReferenceWorkbook(): Promise<{
  filePath: string;
  fileName: string;
  mtimeMs: number;
  size: number;
}> {
  const filePath = resolveLateralReferenceWorkbookPath();
  try {
    const stat = await fs.stat(filePath);
    return {
      filePath,
      fileName: path.basename(filePath),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch {
    const configured = getLateralExcelPath();
    if (configured) {
      throw new Error(
        `Configured ARA_LATERAL_EXCEL_PATH does not exist or is not readable.`
      );
    }
    throw new Error(
      "Lateral Excel workbook path is not configured. Set ARA_LATERAL_EXCEL_PATH or provide data/excel/lateral-mastersheet.xlsm."
    );
  }
}
