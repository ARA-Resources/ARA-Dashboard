/**
 * Sync-time Home metrics refresh for Lateral (Phase 3).
 *
 * Called only after a successful Lateral Dataset pipeline run.
 * Reads the FINAL Dataset Manager Master workbook and writes lightweight
 * metrics via mergeHomeUnitWidgetsMetrics — never affects pipeline success.
 */
import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import path from "node:path";
import { getBusinessUnitById } from "@/constants/business-units";
import {
  countOpeningsFromRows,
  invalidateHomeWidgetsCache,
} from "@/services/home/build-home-widgets";
import {
  isValidHomeUnitMetrics,
  mergeHomeUnitWidgetsMetrics,
  readHomeWidgetsMetricsSnapshot,
} from "@/services/home/home-widgets-metrics-store";
import { parseWorksheet } from "@/services/excel/parse-sheet";
import { resolveReadableExcelPath } from "@/services/excel/readable-workbook";
import { readLateralMasterSheetFromDriveXlsm } from "@/services/excel/read-lateral-master-from-drive-xlsm";
import { DEFAULT_LATERAL_MASTER_SHEET } from "@/types/lateral-processing-setup";

export interface RefreshLateralHomeWidgetsMetricsInput {
  /** Absolute path to the final Dataset Manager / promoted Master workbook */
  filePath: string;
  fileName: string;
  /** Optional Master Sheet title override from Lateral setup */
  masterSheetName?: string | null;
  /** When the pipeline completed (ISO) */
  computedAt?: string;
}

export type RefreshLateralHomeWidgetsMetricsResult =
  | {
      ok: true;
      skipped?: false;
      totals: number;
      active: number;
      posted: number;
      fresh: number;
      rowCount: number;
    }
  | {
      ok: true;
      skipped: true;
      reason: string;
    }
  | {
      ok: false;
      error: string;
    };

function findSheet(workbook: ExcelJS.Workbook, sheetName: string) {
  const exact = workbook.getWorksheet(sheetName);
  if (exact) return exact;
  const normalized = sheetName.trim().toLowerCase();
  return (
    workbook.worksheets.find(
      (sheet) => sheet.name.trim().toLowerCase() === normalized
    ) ?? null
  );
}

/**
 * True when an existing Lateral snapshot is newer than this run
 * (prevents an older sequential success from overwriting newer metrics).
 */
function isIncomingStale(
  existing: {
    mtimeMs: number;
    computedAt: string;
  },
  incoming: { mtimeMs: number; computedAt: string }
): boolean {
  if (existing.mtimeMs > incoming.mtimeMs) return true;
  if (existing.mtimeMs < incoming.mtimeMs) return false;
  const prevAt = Date.parse(existing.computedAt);
  const nextAt = Date.parse(incoming.computedAt);
  if (Number.isFinite(prevAt) && Number.isFinite(nextAt) && prevAt > nextAt) {
    return true;
  }
  return false;
}

/**
 * Calculate Lateral Home metrics from the final Master workbook and merge
 * into `.data/home-widgets-metrics.json`. Safe to call after pipeline success.
 */
export async function refreshLateralHomeWidgetsMetricsFromFinalMaster(
  input: RefreshLateralHomeWidgetsMetricsInput
): Promise<RefreshLateralHomeWidgetsMetricsResult> {
  const filePath = path.resolve(input.filePath);
  const fileName =
    input.fileName?.trim() || path.basename(filePath) || "lateral-master.xlsm";
  const computedAt = input.computedAt || new Date().toISOString();

  let mtimeMs = 0;
  try {
    const stat = await fs.stat(filePath);
    mtimeMs = stat.mtimeMs;
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `Cannot stat final Master workbook: ${error.message}`
          : "Cannot stat final Master workbook.",
    };
  }

  const prior = await readHomeWidgetsMetricsSnapshot();
  const existing = prior.units.lateral;
  if (
    existing &&
    isValidHomeUnitMetrics(existing) &&
    isIncomingStale(
      { mtimeMs: existing.mtimeMs, computedAt: existing.computedAt },
      { mtimeMs, computedAt }
    )
  ) {
    return {
      ok: true,
      skipped: true,
      reason:
        "Skipped Home metrics write — existing Lateral snapshot is newer than this run.",
    };
  }

  const unit = getBusinessUnitById("lateral");
  const sheetName =
    input.masterSheetName?.trim() ||
    unit?.excel.detailSheet ||
    DEFAULT_LATERAL_MASTER_SHEET;
  const headerRow = unit?.excel.detailHeaderRow ?? 1;

  try {
    const readablePath = await resolveReadableExcelPath(filePath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(readablePath);

    const worksheet = findSheet(workbook, sheetName);
    if (!worksheet) {
      const available = workbook.worksheets.map((s) => s.name).join(", ");
      return {
        ok: false,
        error: `Sheet "${sheetName}" not found in ${fileName}. Available: ${available}`,
      };
    }

    const parsed = parseWorksheet(worksheet, { headerRow });
    const counts = countOpeningsFromRows(
      parsed.headers,
      parsed.rows as Array<Record<string, unknown>>
    );

    await mergeHomeUnitWidgetsMetrics("lateral", {
      totals: counts.totals,
      active: counts.active,
      posted: counts.posted,
      fresh: counts.fresh,
      fileName,
      mtimeMs,
      source: "pipeline",
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
      rowCount: parsed.rows.length,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to compute Lateral Home metrics from final Master workbook.",
    };
  }
}

/**
 * Refresh Lateral Home KPIs from PostgreSQL `lateral_master` (VPS primary).
 * Same open/posted/new rules as countOpeningsFromRows for Master Sheet rows.
 */
export async function refreshLateralHomeWidgetsMetricsFromPostgres(options?: {
  computedAt?: string;
}): Promise<RefreshLateralHomeWidgetsMetricsResult> {
  const computedAt = options?.computedAt || new Date().toISOString();

  try {
    const { getDbClient } = await import("@/lib/persistence/db-client");
    const sql = getDbClient();
    const rows = await sql<
      {
        totals: number;
        active: number;
        posted: number;
        fresh: number;
        row_count: number;
      }[]
    >`
      SELECT
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(job_status, '')) IN ('active', 'new', 'reopen')
        )::int AS totals,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(job_status, '')) = 'active'
        )::int AS active,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(job_status, '')) IN ('active', 'new', 'reopen')
            AND LOWER(COALESCE(posted, '')) = 'yes'
        )::int AS posted,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(job_status, '')) = 'new'
        )::int AS fresh,
        COUNT(*)::int AS row_count
      FROM lateral_master
    `;

    const counts = rows[0] ?? {
      totals: 0,
      active: 0,
      posted: 0,
      fresh: 0,
      row_count: 0,
    };

    await mergeHomeUnitWidgetsMetrics("lateral", {
      totals: counts.totals,
      active: counts.active,
      posted: counts.posted,
      fresh: counts.fresh,
      fileName: "lateral_master",
      mtimeMs: Date.now(),
      source: "postgres",
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
      rowCount: counts.row_count,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to compute Lateral Home metrics from PostgreSQL.",
    };
  }
}

/**
 * Refresh Lateral Home KPIs from Drive Master XLSM (file-mode bootstrap only).
 */
export async function refreshLateralHomeWidgetsMetricsFromDriveXlsm(options?: {
  bypassCache?: boolean;
  computedAt?: string;
}): Promise<RefreshLateralHomeWidgetsMetricsResult> {
  const computedAt = options?.computedAt || new Date().toISOString();

  try {
    const sheet = await readLateralMasterSheetFromDriveXlsm({
      sheetName: DEFAULT_LATERAL_MASTER_SHEET,
      headerRow: 1,
      readerOptions: { bypassCache: options?.bypassCache ?? true },
    });

    const counts = countOpeningsFromRows(
      sheet.headers,
      sheet.rows as Array<Record<string, unknown>>
    );

    await mergeHomeUnitWidgetsMetrics("lateral", {
      totals: counts.totals,
      active: counts.active,
      posted: counts.posted,
      fresh: counts.fresh,
      fileName: sheet.sourceFile,
      mtimeMs: sheet.meta.mtimeMs || Date.now(),
      source: "drive-xlsm",
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
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to compute Lateral Home metrics from Drive XLSM.",
    };
  }
}
