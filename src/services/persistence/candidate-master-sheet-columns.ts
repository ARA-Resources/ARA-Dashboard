/**
 * Candidate source header ↔ PostgreSQL `candidate_master` column mapping.
 *
 * `CANDIDATE_MASTER_EXCEL_HEADERS` is the dashboard display / API contract:
 * it decides the on-screen column order — the frontend maps over it and
 * looks up each cell by header name, so order here is purely presentational
 * and safe to change. It does NOT reflect the `candidate_master` schema
 * column order.
 *
 * Mirrors the shape of `executive-master-sheet-columns.ts` / the Lateral
 * equivalent, but is a fully standalone module — no imports from, or shared
 * types with, the lateral/executive column-map modules.
 *
 * This is the FINAL Oorwin-sync-era display shape (16 columns, C1 of the
 * Candidate Master Sheet Oorwin sync plan) — not the original legacy
 * workbook's shape. `importAliases` below still points at the ORIGINAL
 * legacy workbook's header spellings (e.g. "Diversity", "Recruiter") for
 * historical-record purposes only; the one-time legacy import script
 * (`scripts/import-candidate-master-to-postgres.ts`, already run against
 * prod, frozen) has its own independent local column-alias list rather than
 * importing this map, specifically so this dashboard's display shape can
 * keep evolving without ever affecting that frozen script's typecheck or
 * (hypothetical re-run) behavior.
 */

/** Candidate header keys in dashboard display order (Sr. No. is computed client-side, not listed here). */
export const CANDIDATE_MASTER_EXCEL_HEADERS = [
  "Candidate ID",
  "Upload Date",
  "Name",
  "Email",
  "Contact Number",
  "Submitter",
  "Customer",
  "Job Requisition ID",
  "Primary Skills",
  "Job Management Level",
  "Market",
  "Client SPOC",
  "Status",
  "Submitted Date",
  "Submission Comments",
  "Gender",
] as const;

export type CandidateMasterExcelHeader =
  (typeof CANDIDATE_MASTER_EXCEL_HEADERS)[number];

/**
 * Business columns stored for the Candidate Master dataset.
 *
 * Migration 015 (Candidate Master Sheet Oorwin sync feature) renamed 8 of
 * these DB columns in place — no data moved, same values, new names — and
 * added `email`/`client_spoc` (default `'-'` for every pre-existing row,
 * since neither had a legacy-workbook equivalent).
 */
export const CANDIDATE_MASTER_SHEET_DB_COLUMNS = [
  "cid",
  "date_of_upload",
  "name",
  "email",
  "contact_number",
  "submitter", // was recruiter
  "customer", // was atci_vertical
  "job_requisition_id",
  "primary_skills", // was role_name_primary_skill
  "job_management_level", // was management_level
  "market",
  "client_spoc",
  "status", // was status_recruiter
  "submitted_date", // was submitted_date_tracker
  "submission_comments", // was remarks_status
  "gender", // was diversity
] as const;

export type CandidateMasterSheetDbColumn =
  (typeof CANDIDATE_MASTER_SHEET_DB_COLUMNS)[number];

export interface CandidateMasterColumnMapping {
  excelHeader: CandidateMasterExcelHeader;
  dbColumn: CandidateMasterSheetDbColumn;
  /** Alternate source headers accepted on import (workbook spelling first). */
  importAliases: readonly string[];
}

/**
 * One entry per stored column. `excelHeader` is the canonical dashboard
 * display/API key (the new Oorwin-sync shape). `importAliases` is kept only
 * as a historical record of the ORIGINAL legacy workbook's header spelling
 * for each pre-existing column — no live code path reads it (see the
 * `scripts/import-candidate-master-to-postgres.ts` note above); `email`/
 * `client_spoc` have no legacy equivalent so their aliases are empty.
 */
export const CANDIDATE_MASTER_COLUMN_MAP: readonly CandidateMasterColumnMapping[] =
  [
    { excelHeader: "Candidate ID", dbColumn: "cid", importAliases: ["CID"] },
    {
      excelHeader: "Upload Date",
      dbColumn: "date_of_upload",
      importAliases: ["Date of Upload"],
    },
    { excelHeader: "Name", dbColumn: "name", importAliases: ["Name"] },
    { excelHeader: "Email", dbColumn: "email", importAliases: [] },
    {
      excelHeader: "Contact Number",
      dbColumn: "contact_number",
      importAliases: ["Contact Number"],
    },
    {
      excelHeader: "Submitter",
      dbColumn: "submitter",
      importAliases: ["Recruiter"],
    },
    {
      excelHeader: "Customer",
      dbColumn: "customer",
      importAliases: ["ATCI - Vertical", "ATCI-Vertical", "ATCI Vertical"],
    },
    {
      excelHeader: "Job Requisition ID",
      dbColumn: "job_requisition_id",
      importAliases: ["Job Requisition ID"],
    },
    {
      excelHeader: "Primary Skills",
      dbColumn: "primary_skills",
      importAliases: ["Role Name/Primary Skill"],
    },
    {
      excelHeader: "Job Management Level",
      dbColumn: "job_management_level",
      importAliases: [
        "Management Level /Career Level",
        "Management Level/Career Level",
      ],
    },
    { excelHeader: "Market", dbColumn: "market", importAliases: ["Market"] },
    { excelHeader: "Client SPOC", dbColumn: "client_spoc", importAliases: [] },
    {
      excelHeader: "Status",
      dbColumn: "status",
      importAliases: ["Status (Recruiter)"],
    },
    {
      excelHeader: "Submitted Date",
      dbColumn: "submitted_date",
      importAliases: [
        "Submitted Date - Tracker (dd/mm/yyyy)",
        "Submitted Date - Tracker",
      ],
    },
    {
      excelHeader: "Submission Comments",
      dbColumn: "submission_comments",
      importAliases: ["Remarks - Status"],
    },
    {
      excelHeader: "Gender",
      dbColumn: "gender",
      importAliases: ["Diversity"],
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
