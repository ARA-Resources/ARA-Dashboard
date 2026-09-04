/**
 * Excel Master Sheet header ↔ PostgreSQL `lateral_master` column mapping.
 *
 * Header names/order match the local source workbook
 * `data/excel/ATCI Lateral Master Data Updated.xlsx` (Master Sheet).
 * Dashboard API/UI contract uses Excel header keys on every row.
 */

/** Exact Excel headers in sheet column order (source of truth for Master Sheet UI). */
export const LATERAL_MASTER_EXCEL_HEADERS = [
  "Date",
  "Job Requisition ID",
  "Priority",
  "Job Description",
  "Skill Categorization",
  "Primary Skills",
  "Job Management Level",
  "Primary Location/Office lOcate",
  "Market Map",
  "POC",
  "Job Status",
  "Opened on Oorwin",
  "Posted",
] as const;

export type LateralMasterExcelHeader =
  (typeof LATERAL_MASTER_EXCEL_HEADERS)[number];

/** Business columns stored for Master Sheet (excludes operational timestamps). */
export const LATERAL_MASTER_SHEET_DB_COLUMNS = [
  "date",
  "job_requisition_id",
  "priority",
  "job_description",
  "skill_categorization",
  "primary_skills",
  "job_management_level",
  "primary_location",
  "market_map",
  "poc",
  "job_status",
  "opened_on_oorwin",
  "posted",
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
    excelHeader: "Primary Skills",
    dbColumn: "primary_skills",
    importAliases: ["Primary Skills"],
  },
  {
    excelHeader: "Job Management Level",
    dbColumn: "job_management_level",
    importAliases: ["Job Management Level"],
  },
  {
    excelHeader: "Primary Location/Office lOcate",
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
    excelHeader: "Opened on Oorwin",
    dbColumn: "opened_on_oorwin",
    importAliases: ["Opened on Oorwin"],
  },
  {
    excelHeader: "Posted",
    dbColumn: "posted",
    importAliases: ["Posted"],
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
