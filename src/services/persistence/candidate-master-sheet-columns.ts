/**
 * Candidate source header ↔ PostgreSQL `candidate_master` column mapping.
 *
 * `CANDIDATE_MASTER_EXCEL_HEADERS` is the dashboard display / API contract:
 * it decides the on-screen column order — the frontend maps over it and
 * looks up each cell by header name, so order here is purely presentational
 * and safe to change. It does NOT reflect the `candidate_master` schema
 * column order; the one-time import matches the real workbook headers via
 * `importAliases`.
 *
 * Mirrors the shape of `executive-master-sheet-columns.ts` / the Lateral
 * equivalent, but is a fully standalone module — no imports from, or shared
 * types with, the lateral/executive column-map modules.
 *
 * Source: "ATCI Candidate Master Data.xlsx", sheet "ATCI". Dropped vs. the
 * source sheet: "SNo" (Sr. No. is computed client-side) and every column
 * after "Remarks - Status" (Resubmission Date onward).
 */

/** Candidate header keys in dashboard display order (matches source sheet order, minus SNo). */
export const CANDIDATE_MASTER_EXCEL_HEADERS = [
  "CID",
  "Name",
  "Diversity",
  "Contact Number",
  "Date of Upload",
  "Recruiter",
  "ATCI - Vertical",
  "Job Requisition ID",
  "Role Name/Primary Skill",
  "Management Level /Career Level",
  "Market",
  "Submitted Date - Tracker (dd/mm/yyyy)",
  "Status (Recruiter)",
  "Remarks - Status",
] as const;

export type CandidateMasterExcelHeader =
  (typeof CANDIDATE_MASTER_EXCEL_HEADERS)[number];

/** Business columns stored for the Candidate Master dataset. */
export const CANDIDATE_MASTER_SHEET_DB_COLUMNS = [
  "cid",
  "name",
  "diversity",
  "contact_number",
  "date_of_upload",
  "recruiter",
  "atci_vertical",
  "job_requisition_id",
  "role_name_primary_skill",
  "management_level",
  "market",
  "submitted_date_tracker",
  "status_recruiter",
  "remarks_status",
] as const;

export type CandidateMasterSheetDbColumn =
  (typeof CANDIDATE_MASTER_SHEET_DB_COLUMNS)[number];

export interface CandidateMasterColumnMapping {
  excelHeader: CandidateMasterExcelHeader;
  dbColumn: CandidateMasterSheetDbColumn;
  /** Alternate source headers accepted on import (workbook spelling first). */
  importAliases: readonly string[];
}

/** One entry per stored column. `excelHeader` is the canonical display/API key. */
export const CANDIDATE_MASTER_COLUMN_MAP: readonly CandidateMasterColumnMapping[] =
  [
    { excelHeader: "CID", dbColumn: "cid", importAliases: ["CID"] },
    { excelHeader: "Name", dbColumn: "name", importAliases: ["Name"] },
    {
      excelHeader: "Diversity",
      dbColumn: "diversity",
      importAliases: ["Diversity"],
    },
    {
      excelHeader: "Contact Number",
      dbColumn: "contact_number",
      importAliases: ["Contact Number"],
    },
    {
      excelHeader: "Date of Upload",
      dbColumn: "date_of_upload",
      importAliases: ["Date of Upload"],
    },
    {
      excelHeader: "Recruiter",
      dbColumn: "recruiter",
      importAliases: ["Recruiter"],
    },
    {
      excelHeader: "ATCI - Vertical",
      dbColumn: "atci_vertical",
      importAliases: ["ATCI - Vertical", "ATCI-Vertical", "ATCI Vertical"],
    },
    {
      excelHeader: "Job Requisition ID",
      dbColumn: "job_requisition_id",
      importAliases: ["Job Requisition ID"],
    },
    {
      excelHeader: "Role Name/Primary Skill",
      dbColumn: "role_name_primary_skill",
      importAliases: ["Role Name/Primary Skill"],
    },
    {
      excelHeader: "Management Level /Career Level",
      dbColumn: "management_level",
      importAliases: [
        "Management Level /Career Level",
        "Management Level/Career Level",
      ],
    },
    { excelHeader: "Market", dbColumn: "market", importAliases: ["Market"] },
    {
      excelHeader: "Submitted Date - Tracker (dd/mm/yyyy)",
      dbColumn: "submitted_date_tracker",
      importAliases: [
        "Submitted Date - Tracker (dd/mm/yyyy)",
        "Submitted Date - Tracker",
      ],
    },
    {
      excelHeader: "Status (Recruiter)",
      dbColumn: "status_recruiter",
      importAliases: ["Status (Recruiter)"],
    },
    {
      excelHeader: "Remarks - Status",
      dbColumn: "remarks_status",
      importAliases: ["Remarks - Status"],
    },
  ];

export const CANDIDATE_MASTER_PG_SOURCE_FILE = "candidate_master";
export const CANDIDATE_MASTER_PG_SOURCE_LABEL = "postgres:candidate_master";

export function excelHeaderForCandidateDbColumn(
  dbColumn: CandidateMasterSheetDbColumn
): CandidateMasterExcelHeader {
  const hit = CANDIDATE_MASTER_COLUMN_MAP.find((m) => m.dbColumn === dbColumn);
  if (!hit) {
    throw new Error(`[candidate-master-columns] Unknown DB column: ${dbColumn}`);
  }
  return hit.excelHeader;
}
