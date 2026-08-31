import type { ExcelCellValue, ExcelDataRow, ExcelSheetMeta } from "../../types/excel.js";

/**
 * Executive Master Sheet workbook contract (Phase 1 / Aug 21 XLSM).
 * Header row = 1. Live columns = A–W only.
 */

export const EXECUTIVE_MASTER_SHEET_NAME = "Master Sheet";
export const EXECUTIVE_MASTER_HEADER_ROW = 1;

export const EXECUTIVE_MASTER_LIVE_COLUMNS = [
  "Job Requisition ID",
  "Market",
  "Primary skills",
  "Primary Location",
  "Level",
  "Must Have skills",
  "yrs of Experience",
  "Ageing Slab",
  "Location Flex",
  "Skill category",
  "Job Description",
  "Active Pipeline",
  "Job Status",
  "Posted",
  "Priority",
  "Opened on Oorwin",
  "Team Auto",
  "Team Manual",
  "Team Lead",
  "Team Member 1",
  "Team Member 2",
  "Date of New JR",
  "Niche Roles",
] as const;

export type ExecutiveMasterLiveColumn =
  (typeof EXECUTIVE_MASTER_LIVE_COLUMNS)[number];

export type ExecutiveMasterDataSourceKind = "drive" | "local" | "bundled";

export type ExecutiveMasterSheetRow = {
  id: string;
} & {
  [K in ExecutiveMasterLiveColumn]: ExcelCellValue;
};

export interface ExecutiveMasterSheetReadResult {
  businessUnitId: "executive";
  sheetName: string;
  sourceKind: ExecutiveMasterDataSourceKind;
  sourceFile: string;
  sourceLabel: string;
  headers: ExecutiveMasterLiveColumn[];
  rows: ExecutiveMasterSheetRow[];
  meta: ExcelSheetMeta & {
    sourceKind: ExecutiveMasterDataSourceKind;
    headerRow: number;
  };
}

function asTrimmedHeader(value: string): string {
  return value.replace(/\u00a0/g, " ").trim();
}

export function projectExecutiveMasterLiveColumns(
  headers: string[],
  rows: ExcelDataRow[]
): { headers: ExecutiveMasterLiveColumn[]; rows: ExecutiveMasterSheetRow[] } {
  const byLower = new Map<string, string>();
  for (const header of headers) {
    const key = asTrimmedHeader(header).toLowerCase();
    if (!key) continue;
    if (!byLower.has(key)) byLower.set(key, header);
  }

  const liveHeaders = [...EXECUTIVE_MASTER_LIVE_COLUMNS];
  const sourceKeys = liveHeaders.map((live) => {
    const source = byLower.get(live.toLowerCase());
    return source ?? live;
  });

  const projectedRows: ExecutiveMasterSheetRow[] = rows.map((row) => {
    const next = { id: String(row.id) } as ExecutiveMasterSheetRow;
    for (let i = 0; i < liveHeaders.length; i += 1) {
      const live = liveHeaders[i];
      const source = sourceKeys[i];
      const value = row[source];
      next[live] =
        value === undefined || value === null || value === ""
          ? null
          : (value as ExcelCellValue);
    }
    return next;
  });

  return { headers: liveHeaders, rows: projectedRows };
}

export function validateExecutiveMasterHeaders(headers: string[]): {
  ok: boolean;
  missing: string[];
  present: string[];
} {
  const byLower = new Set(
    headers.map((header) => asTrimmedHeader(header).toLowerCase()).filter(Boolean)
  );
  const missing: string[] = [];
  const present: string[] = [];

  for (const required of EXECUTIVE_MASTER_LIVE_COLUMNS) {
    if (byLower.has(required.toLowerCase())) {
      present.push(required);
    } else {
      missing.push(required);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    present,
  };
}

export function assertExecutiveMasterHeaders(headers: string[]): void {
  const result = validateExecutiveMasterHeaders(headers);
  if (result.ok) return;
  throw new Error(
    `Executive Master Sheet is missing required headers: ${result.missing.join(", ")}`
  );
}
