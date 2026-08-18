import { readLateralMasterSheetFromDriveXlsmVercelSafe } from "@/services/excel/read-lateral-master-from-drive-xlsm-vercel-safe";
import {
  NativePRolesEngine,
  toPRolesMasterRows,
} from "@/services/lateral-processing/lateral-p-roles-native";
import {
  pRolesResultToRows,
  resolvePRolesEngineKind,
  type PRolesFilterSelection,
} from "@/services/lateral-processing/lateral-p-roles-engine";
import type { ExcelOpeningsResult } from "@/types/excel";
import type { OpeningsFilters } from "@/types/filters";

function extractPRolesFilters(filters?: OpeningsFilters): PRolesFilterSelection {
  return {
    jobStatus: filters?.columnFilters?.["Job Status"] ?? [],
    posted: filters?.columnFilters?.["Posted"] ?? [],
    marketMap: filters?.columnFilters?.["Market Map"] ?? [],
  };
}

export async function buildLateralPRolesOpenings(
  filters?: OpeningsFilters,
  options?: { forceVercelSafeNative?: boolean }
): Promise<ExcelOpeningsResult> {
  const masterSheet = await readLateralMasterSheetFromDriveXlsmVercelSafe({
    sheetName: "Master Sheet",
    headerRow: 1,
    bypassCache: false,
  });
  const masterRows = toPRolesMasterRows(masterSheet);
  const pRolesFilters = extractPRolesFilters(filters);

  const forcedNative = options?.forceVercelSafeNative === true;
  const kind = forcedNative ? "native" : resolvePRolesEngineKind();
  const engine =
    kind === "native"
      ? NativePRolesEngine
      : (await import("@/services/lateral-processing/lateral-p-roles-excel"))
          .ExcelPRolesEngine;
  const result = await engine.generate({ masterRows, filters: pRolesFilters });
  const table = pRolesResultToRows(result);

  return {
    businessUnitId: "lateral",
    sheetName: "P-Roles",
    sourceFile: masterSheet.sourceFile,
    sourceLabel: `Master Sheet → P-Roles (${result.metadata.engine})`,
    headers: table.headers,
    rows: table.rows,
    appliedFilters: filters,
    meta: {
      name: "P-Roles",
      rowCount: table.rows.length,
      columnCount: table.headers.length,
      headerRow: 1,
      filePath: masterSheet.meta.filePath,
      mtimeMs: masterSheet.meta.mtimeMs,
      totalRows: table.rows.length,
      filteredDetailCount: result.totals.totalJobs,
      topN: filters?.topN ?? undefined,
      hasColumnFilters: Boolean(
        (filters?.columnFilters && Object.keys(filters.columnFilters).length > 0) ||
          false
      ),
    },
  };
}
