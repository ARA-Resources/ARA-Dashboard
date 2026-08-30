/**
 * Home metrics refresh for Executive.
 *
 * Mirrors Lateral's refresh pattern: read Executive Master Sheet, count openings
 * with the shared countOpeningsFromRows rules, merge into the home widgets
 * snapshot. Does not modify Lateral metrics or pipeline.
 *
 * Uses ExcelJS + established Executive workbook resolution (local/bundled).
 * Drive is used when ARA_EXECUTIVE_MASTER_DRIVE_FILE_ID is configured.
 */
import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import {
  countOpeningsFromRows,
  invalidateHomeWidgetsCache,
} from "@/services/home/build-home-widgets";
import { mergeHomeUnitWidgetsMetrics } from "@/services/home/home-widgets-metrics-store";
import { parseWorksheet } from "@/services/excel/parse-sheet";
import { resolveReadableExcelPath } from "@/services/excel/readable-workbook";
import {
  assertConfiguredExecutiveExcelPath,
  getBundledExecutiveExcelPath,
  getExecutiveExcelPath,
} from "@/lib/config/runtime";
import {
  EXECUTIVE_MASTER_HEADER_ROW,
  EXECUTIVE_MASTER_LIVE_COLUMNS,
  EXECUTIVE_MASTER_SHEET_NAME,
  projectExecutiveMasterLiveColumns,
} from "@/services/excel/executive-master-sheet";
import { hasExecutiveMasterDriveFileIdConfigured } from "@/services/excel/read-executive-master-from-drive-xlsm";

export type RefreshExecutiveHomeWidgetsMetricsResult =
  | {
      ok: true;
      totals: number;
      active: number;
      posted: number;
      fresh: number;
      rowCount: number;
      sourceKind: "drive" | "local" | "bundled";
    }
  | {
      ok: false;
      error: string;
    };

async function resolveLocalOrBundledReadable(): Promise<{
  readablePath: string;
  fileName: string;
  mtimeMs: number;
  sourceKind: "local" | "bundled";
}> {
  assertConfiguredExecutiveExcelPath();
  const local = getExecutiveExcelPath();
  const filePath = local || getBundledExecutiveExcelPath();
  const sourceKind: "local" | "bundled" = local ? "local" : "bundled";
  const stat = await fs.stat(filePath);
  const readablePath = await resolveReadableExcelPath(filePath);
  return {
    readablePath,
    fileName: filePath.split(/[/\\]/).pop() || "executive-mastersheet.xlsm",
    mtimeMs: stat.mtimeMs,
    sourceKind,
  };
}

async function loadExecutiveMasterRows(): Promise<{
  headers: string[];
  rows: Array<Record<string, unknown>>;
  fileName: string;
  mtimeMs: number;
  sourceKind: "drive" | "local" | "bundled";
}> {
  if (hasExecutiveMasterDriveFileIdConfigured()) {
    try {
      const { readExecutiveMasterSheetFromDriveXlsm } = await import(
        "@/services/excel/read-executive-master-from-drive-xlsm"
      );
      const sheet = await readExecutiveMasterSheetFromDriveXlsm({
        sheetName: EXECUTIVE_MASTER_SHEET_NAME,
        headerRow: EXECUTIVE_MASTER_HEADER_ROW,
        readerOptions: { bypassCache: true },
      });
      const projected = projectExecutiveMasterLiveColumns(
        sheet.headers,
        sheet.rows
      );
      return {
        headers: [...EXECUTIVE_MASTER_LIVE_COLUMNS],
        rows: projected.rows as Array<Record<string, unknown>>,
        fileName: sheet.sourceFile || "executive-drive.xlsm",
        mtimeMs: sheet.meta.mtimeMs || Date.now(),
        sourceKind: "drive",
      };
    } catch (error) {
      console.warn(
        "[home-widgets] Executive Drive read failed; falling back to local workbook.",
        error instanceof Error ? error.message : error
      );
    }
  }

  const local = await resolveLocalOrBundledReadable();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(local.readablePath);
  const worksheet =
    workbook.worksheets.find(
      (sheet) =>
        sheet.name.trim().toLowerCase() ===
        EXECUTIVE_MASTER_SHEET_NAME.toLowerCase()
    ) ?? null;
  if (!worksheet) {
    throw new Error(
      `Sheet "${EXECUTIVE_MASTER_SHEET_NAME}" not found in ${local.fileName}.`
    );
  }
  const parsed = parseWorksheet(worksheet, {
    headerRow: EXECUTIVE_MASTER_HEADER_ROW,
  });
  const projected = projectExecutiveMasterLiveColumns(
    parsed.headers,
    parsed.rows.map((row, index) => ({
      id: `executive-home-${index + 1}`,
      ...row,
    }))
  );
  return {
    headers: [...EXECUTIVE_MASTER_LIVE_COLUMNS],
    rows: projected.rows as Array<Record<string, unknown>>,
    fileName: local.fileName,
    mtimeMs: local.mtimeMs,
    sourceKind: local.sourceKind,
  };
}

/**
 * Refresh Executive Home KPIs from the established Executive Master Sheet source
 * (Drive → local → bundled). Safe to call from Home bootstrap.
 */
export async function refreshExecutiveHomeWidgetsMetrics(options?: {
  bypassCache?: boolean;
  computedAt?: string;
}): Promise<RefreshExecutiveHomeWidgetsMetricsResult> {
  void options?.bypassCache;
  const computedAt = options?.computedAt || new Date().toISOString();

  try {
    const sheet = await loadExecutiveMasterRows();
    const counts = countOpeningsFromRows(sheet.headers, sheet.rows);

    await mergeHomeUnitWidgetsMetrics("executive", {
      totals: counts.totals,
      active: counts.active,
      posted: counts.posted,
      fresh: counts.fresh,
      fileName: sheet.fileName,
      mtimeMs: sheet.mtimeMs,
      source: sheet.sourceKind === "drive" ? "drive-xlsm" : "bootstrap",
      computedAt,
      error: null,
    });

    invalidateHomeWidgetsCache();

    return {
      ok: true,
      totals: counts.totals,
      active: counts.active,
      posted: counts.posted,
      fresh: counts.fresh,
      rowCount: sheet.rows.length,
      sourceKind: sheet.sourceKind,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to compute Executive Home metrics from Master Sheet.",
    };
  }
}
