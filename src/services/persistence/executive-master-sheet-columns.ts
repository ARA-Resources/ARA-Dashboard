/**
 * Executive source header ↔ PostgreSQL `executive_master` column mapping.
 *
 * `EXECUTIVE_MASTER_EXCEL_HEADERS` is the dashboard display / API contract: it
 * decides the on-screen column order AND any Download (.xlsx) column order — the
 * frontend maps over it and looks up each cell by header name, so order here is
 * purely presentational and safe to change. It does NOT reflect the source
 * workbook's physical column order or the `executive_master` schema; the one-time
 * import matches the real workbook headers via `importAliases`.
 *
 * Mirrors `lateral-master-sheet-columns.ts`. Differences from Lateral:
 * - Executive renames on import: Market → Market Map, Primary skills → Primary
 *   Skills, Level → Job Management Level, Skill category → Skill Categorization,
 *   Must Have skills → Must Have Skills.
 * - Executive keeps Must Have Skills + Location Flex; has no POC / Opened on
 *   Oorwin.
 * - The source "Active Pipeline" column is intentionally not mapped.
 */

/** Executive header keys in dashboard display order. */
export const EXECUTIVE_MASTER_EXCEL_HEADERS = [
  "Date",
  "Job Requisition ID",
  "Market Map",
  "Primary Skills",
  "Primary Location",
  "Job Management Level",
  "Must Have Skills",
  "Location Flex",
  "Skill Categorization",
  "Job Description",
  "Job Status",
  "Posted",
  "Priority",
] as const;

export type ExecutiveMasterExcelHeader =
  (typeof EXECUTIVE_MASTER_EXCEL_HEADERS)[number];

/** Business columns stored for the Executive Master dataset. */
export const EXECUTIVE_MASTER_SHEET_DB_COLUMNS = [
  "date",
  "job_requisition_id",
  "market_map",
  "primary_skills",
  "primary_location",
  "job_management_level",
  "must_have_skills",
  "location_flex",
  "skill_categorization",
  "job_description",
  "job_status",
  "posted",
  "priority",
] as const;

export type ExecutiveMasterSheetDbColumn =
  (typeof EXECUTIVE_MASTER_SHEET_DB_COLUMNS)[number];

export interface ExecutiveMasterColumnMapping {
  excelHeader: ExecutiveMasterExcelHeader;
  dbColumn: ExecutiveMasterSheetDbColumn;
  /** Alternate source headers accepted on import (workbook spelling first). */
  importAliases: readonly string[];
}

/** One entry per stored column. `excelHeader` is the canonical display/API key. */
export const EXECUTIVE_MASTER_COLUMN_MAP: readonly ExecutiveMasterColumnMapping[] =
  [
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
      excelHeader: "Market Map",
      dbColumn: "market_map",
      importAliases: ["Market", "Market Map"],
    },
    {
      excelHeader: "Primary Skills",
      dbColumn: "primary_skills",
      importAliases: ["Primary skills", "Primary Skills"],
    },
    {
      excelHeader: "Primary Location",
      dbColumn: "primary_location",
      importAliases: ["Primary Location", "Primary Location/Office Locate"],
    },
    {
      excelHeader: "Job Management Level",
      dbColumn: "job_management_level",
      importAliases: ["Level", "Job Management Level"],
    },
    {
      excelHeader: "Must Have Skills",
      dbColumn: "must_have_skills",
      importAliases: ["Must Have skills", "Must have skills", "Must Have Skills"],
    },
    {
      excelHeader: "Location Flex",
      dbColumn: "location_flex",
      importAliases: ["Location Flex"],
    },
    {
      excelHeader: "Skill Categorization",
      dbColumn: "skill_categorization",
      importAliases: ["Skill category", "Skill Category", "Skill Categorization"],
    },
    {
      excelHeader: "Job Description",
      dbColumn: "job_description",
      importAliases: ["Job Description"],
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
      excelHeader: "Priority",
      dbColumn: "priority",
      importAliases: ["Priority"],
    },
  ];

export const EXECUTIVE_MASTER_PG_SOURCE_FILE = "executive_master";
export const EXECUTIVE_MASTER_PG_SOURCE_LABEL = "postgres:executive_master";

export function excelHeaderForExecutiveDbColumn(
  dbColumn: ExecutiveMasterSheetDbColumn
): ExecutiveMasterExcelHeader {
  const hit = EXECUTIVE_MASTER_COLUMN_MAP.find((m) => m.dbColumn === dbColumn);
  if (!hit) {
    throw new Error(`[executive-master-columns] Unknown DB column: ${dbColumn}`);
  }
  return hit.excelHeader;
}

export function executiveDbColumnForHeader(
  header: string
): ExecutiveMasterSheetDbColumn | null {
  const exact = EXECUTIVE_MASTER_COLUMN_MAP.find(
    (m) => m.excelHeader === header
  );
  if (exact) return exact.dbColumn;
  const lower = header.trim().toLowerCase();
  for (const m of EXECUTIVE_MASTER_COLUMN_MAP) {
    if (m.importAliases.some((a) => a.toLowerCase() === lower)) {
      return m.dbColumn;
    }
  }
  return null;
}
