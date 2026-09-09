/**
 * Excel Master Sheet header ↔ PostgreSQL `lateral_master` column mapping.
 *
 * `LATERAL_MASTER_EXCEL_HEADERS` is the dashboard display/API contract: it
 * decides the on-screen column order AND the Download (.xlsx) column order —
 * the frontend maps over it and looks up each cell by header name, so order
 * here is purely presentational and safe to change. It does NOT reflect the
 * source workbook's physical column order or the `lateral_master` schema; the
 * import/sync pipeline matches the real workbook headers via `importAliases`.
 * Dashboard API/UI contract uses these Excel header keys on every row.
 */

/** Excel header keys in dashboard display order (drives the table + export). */
export const LATERAL_MASTER_EXCEL_HEADERS = [
  "Date",
  "Job Requisition ID",
  "Primary Skills",
  "Priority",
  "Job Description",
  "Skill Categorization",
  "Job Management Level",
  "Primary Location",
  "Market Map",
  "POC",
  "Job Status",
  "Posted",
  "Opened on Oorwin",
] as const;

export type LateralMasterExcelHeader =
  (typeof LATERAL_MASTER_EXCEL_HEADERS)[number];

/** Business columns stored for Master Sheet, parallel to the headers above. */
export const LATERAL_MASTER_SHEET_DB_COLUMNS = [
  "date",
  "job_requisition_id",
  "primary_skills",
  "priority",
  "job_description",
  "skill_categorization",
  "job_management_level",
  "primary_location",
  "market_map",
  "poc",
  "job_status",
  "posted",
  "opened_on_oorwin",
] as const;

export type LateralMasterSheetDbColumn =
  (typeof LATERAL_MASTER_SHEET_DB_COLUMNS)[number];

export interface LateralMasterColumnMapping {
  excelHeader: LateralMasterExcelHeader;
  dbColumn: LateralMasterSheetDbColumn;
  /** Alternate Excel headers accepted on import (case/spelling variants). */
  importAliases: readonly string[];
}

/**
 * One entry per Excel column. `excelHeader` is the canonical display/API key.
 */
export const LATERAL_MASTER_COLUMN_MAP: readonly LateralMasterColumnMapping[] = [
  {
    excelHeader: "Date",
    dbColumn: "date",
    importAliases: ["Date"],
  },
  {
    excelHeader: "Job Requisition ID",
    dbColumn: "job_requisition_id",
    importAliases: ["Job Requisition ID"],
  },
  {
    excelHeader: "Primary Skills",
    dbColumn: "primary_skills",
    importAliases: ["Primary Skills"],
  },
  {
    excelHeader: "Priority",
    dbColumn: "priority",
    importAliases: ["Priority"],
  },
  {
    excelHeader: "Job Description",
    dbColumn: "job_description",
    importAliases: ["Job Description"],
  },
  {
    excelHeader: "Skill Categorization",
    dbColumn: "skill_categorization",
    importAliases: ["Skill Categorization"],
  },
  {
    excelHeader: "Job Management Level",
    dbColumn: "job_management_level",
    importAliases: ["Job Management Level"],
  },
  {
    // Display label shortened from the raw workbook header. Import/sync still
    // recognises the original spellings via importAliases (workbook spelling
    // stays first so header matching prefers it).
    excelHeader: "Primary Location",
    dbColumn: "primary_location",
    importAliases: [
      "Primary Location/Office lOcate",
      "Primary Location/Office Locate",
      "Primary Location/Office locate",
      "Primary Location",
    ],
  },
  {
    excelHeader: "Market Map",
    dbColumn: "market_map",
    importAliases: ["Market Map"],
  },
  {
    excelHeader: "POC",
    dbColumn: "poc",
    importAliases: ["POC"],
  },
  {
    excelHeader: "Job Status",
    dbColumn: "job_status",
    importAliases: ["Job Status"],
  },
  {
    excelHeader: "Posted",
    dbColumn: "posted",
    importAliases: ["Posted"],
  },
  {
    excelHeader: "Opened on Oorwin",
    dbColumn: "opened_on_oorwin",
    importAliases: ["Opened on Oorwin"],
  },
];

export const LATERAL_MASTER_PG_SOURCE_FILE = "lateral_master";
export const LATERAL_MASTER_PG_SOURCE_LABEL = "postgres:lateral_master";

export function excelHeaderForDbColumn(
  dbColumn: LateralMasterSheetDbColumn
): LateralMasterExcelHeader {
  const hit = LATERAL_MASTER_COLUMN_MAP.find((m) => m.dbColumn === dbColumn);
  if (!hit) {
    throw new Error(`[lateral-master-columns] Unknown DB column: ${dbColumn}`);
  }
  return hit.excelHeader;
}

export function dbColumnForExcelHeader(
  header: string
): LateralMasterSheetDbColumn | null {
  const exact = LATERAL_MASTER_COLUMN_MAP.find((m) => m.excelHeader === header);
  if (exact) return exact.dbColumn;
  const lower = header.trim().toLowerCase();
  for (const m of LATERAL_MASTER_COLUMN_MAP) {
    if (m.importAliases.some((a) => a.toLowerCase() === lower)) {
      return m.dbColumn;
    }
  }
  return null;
}
