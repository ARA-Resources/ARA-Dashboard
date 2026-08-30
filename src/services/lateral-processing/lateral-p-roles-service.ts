/**
 * Lateral P-Roles openings builder.
 *
 * Phase 8.2: Primary data source is PostgreSQL `lateral_master`
 * via `listLateralMasterForPRoles()` (Phase 8.1 read layer).
 *
 * Aggregation, filters, sort, and top-N remain NativePRolesEngine +
 * applySortAndTopN — unchanged from the Drive/XLSM era.
 *
 * Drive/XLSM path is retained only for Phase 8.2 parity comparison
 * (`source: "drive-xlsm"`), loaded via dynamic import so the API path
 * has no Drive/XLSM dependency.
 */
import { applySortAndTopN } from "@/services/excel/apply-filters";
import { NativePRolesEngine } from "@/services/lateral-processing/lateral-p-roles-native";
import {
  pRolesResultToRows,
  type PRolesFilterSelection,
  type PRolesMasterRow,
} from "@/services/lateral-processing/lateral-p-roles-engine";
import { listLateralMasterForPRoles } from "@/services/persistence/read-lateral-master";
import type { ExcelOpeningsResult } from "@/types/excel";
import type { OpeningsFilters } from "@/types/filters";

export type LateralPRolesDataSource = "postgres" | "drive-xlsm";

export function extractPRolesFilters(
  filters?: OpeningsFilters
): PRolesFilterSelection {
  return {
    jobStatus: filters?.columnFilters?.["Job Status"] ?? [],
    posted: filters?.columnFilters?.["Posted"] ?? [],
    marketMap: filters?.columnFilters?.["Market Map"] ?? [],
  };
}

async function loadMasterRowsFromPostgres(): Promise<PRolesMasterRow[]> {
  // Load all Master rows; NativePRolesEngine applies Job Status / Posted /
  // Market Map filters — same order as the former Drive path.
  const rows = await listLateralMasterForPRoles();
  return rows.map((row) => ({
    jobRequisitionId: row.jobRequisitionId,
    primarySkills: row.primarySkills,
    skillCategorization: row.skillCategorization,
    jobManagementLevel: row.jobManagementLevel,
    jobStatus: row.jobStatus,
    posted: row.posted,
    marketMap: row.marketMap,
  }));
}

async function loadMasterRowsFromDriveXlsm(): Promise<{
  masterRows: PRolesMasterRow[];
  sourceFile: string;
  sourceLabel: string;
  filePath?: string;
  mtimeMs?: number;
}> {
  const { readLateralMasterSheetFromDriveXlsmVercelSafe } = await import(
    "@/services/excel/read-lateral-master-from-drive-xlsm-vercel-safe"
  );
  const { toPRolesMasterRows } = await import(
    "@/services/lateral-processing/lateral-p-roles-native"
  );
  const masterSheet = await readLateralMasterSheetFromDriveXlsmVercelSafe({
    sheetName: "Master Sheet",
    headerRow: 1,
    bypassCache: false,
  });
  return {
    masterRows: toPRolesMasterRows(masterSheet),
    sourceFile: masterSheet.sourceFile,
    sourceLabel: masterSheet.sourceLabel || masterSheet.sourceFile,
    filePath: masterSheet.meta.filePath,
    mtimeMs: masterSheet.meta.mtimeMs,
  };
}

async function buildOpeningsResult(options: {
  masterRows: PRolesMasterRow[];
  filters?: OpeningsFilters;
  sourceFile: string;
  sourceLabelPrefix: string;
  filePath?: string;
  mtimeMs?: number;
}): Promise<ExcelOpeningsResult> {
  const pRolesFilters = extractPRolesFilters(options.filters);
  const result = await NativePRolesEngine.generate({
    masterRows: options.masterRows,
    filters: pRolesFilters,
  });
  const table = pRolesResultToRows(result);
  const ranked = applySortAndTopN(table.headers, table.rows, {
    sortBy: options.filters?.sortBy ?? null,
    sortDirection: options.filters?.sortDirection ?? "desc",
    topN: options.filters?.topN ?? null,
  }).map((row, index) => ({
    ...row,
    id: String(row.id ?? `p-roles-${index + 1}`),
  }));

  return {
    businessUnitId: "lateral",
    sheetName: "P-Roles",
    sourceFile: options.sourceFile,
    sourceLabel: `${options.sourceLabelPrefix} → P-Roles (${result.metadata.engine})`,
    headers: table.headers,
    rows: ranked,
    appliedFilters: options.filters,
    meta: {
      name: "P-Roles",
      rowCount: ranked.length,
      columnCount: table.headers.length,
      headerRow: 1,
      filePath: options.filePath,
      mtimeMs: options.mtimeMs,
      totalRows: table.rows.length,
      filteredDetailCount: result.totals.totalJobs,
      topN: options.filters?.topN ?? undefined,
      hasColumnFilters: Boolean(
        (options.filters?.columnFilters &&
          Object.keys(options.filters.columnFilters).length > 0) ||
          false
      ),
    },
  };
}

/**
 * Build Lateral P-Roles openings for the Accenture dashboard.
 *
 * Default source: PostgreSQL `lateral_master` (Phase 8.2).
 * Pass `source: "drive-xlsm"` only for parity validation — not used by the API.
 *
 * `forceVercelSafeNative` is accepted for API compatibility; the PostgreSQL
 * path always uses NativePRolesEngine (Excel workbook engine is not used).
 */
export async function buildLateralPRolesOpenings(
  filters?: OpeningsFilters,
  options?: {
    forceVercelSafeNative?: boolean;
    source?: LateralPRolesDataSource;
  }
): Promise<ExcelOpeningsResult> {
  void options?.forceVercelSafeNative;
  const source: LateralPRolesDataSource = options?.source ?? "postgres";

  if (source === "drive-xlsm") {
    const drive = await loadMasterRowsFromDriveXlsm();
    return buildOpeningsResult({
      masterRows: drive.masterRows,
      filters,
      sourceFile: drive.sourceFile,
      sourceLabelPrefix: "Master Sheet",
      filePath: drive.filePath,
      mtimeMs: drive.mtimeMs,
    });
  }

  const masterRows = await loadMasterRowsFromPostgres();
  return buildOpeningsResult({
    masterRows,
    filters,
    sourceFile: "lateral_master",
    sourceLabelPrefix: "PostgreSQL lateral_master",
    filePath: "postgres:lateral_master",
    mtimeMs: 0,
  });
}
