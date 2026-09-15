-- Migration 012: candidate_master table (ATCI Candidate Master Data .xlsx → PostgreSQL)
-- Idempotent: safe to run multiple times (IF NOT EXISTS).
-- Fully standalone: no foreign keys / relationships to lateral_master or
-- executive_master, and no shared business-key assumptions with either.
-- Does NOT modify any existing application tables.
-- Does NOT import data or change application logic.
-- Run via: npm run db:migrate

BEGIN;

-- ============================================================
-- candidate_master
-- One-time snapshot of the ATCI Candidate Master Data workbook (sheet
-- "ATCI"). Columns mirror the source sheet, minus "SNo" (the UI computes a
-- dynamic Sr. No. client-side instead) and minus every column after
-- "Remarks - Status" (Resubmission Date, Workday Status, Jathin Report
-- status, Screening Status are intentionally dropped).
--
-- No business key is unique/clean enough in the source (CID has blanks,
-- duplicates, and data-entry errors) to serve as a primary key, so `id` is a
-- plain auto-increment surrogate key. Rows are inserted in source sheet row
-- order, so `ORDER BY id` reproduces the original row order.
--
-- Every column is free TEXT. Blank source cells (including fully blank
-- source rows) are imported as the literal "-" — an explicit, intentional
-- choice for this table (unlike lateral_master / executive_master, which
-- store SQL NULL for blanks). date_of_upload / submitted_date_tracker are
-- also TEXT, not DATE: the source has unparseable/malformed values mixed
-- into otherwise-valid dates (see the one-time import script for the exact
-- row-level corrections applied), so free text avoids failing or silently
-- coercing those.
-- ============================================================
CREATE TABLE IF NOT EXISTS candidate_master (
  id                      BIGSERIAL PRIMARY KEY,
  cid                     TEXT NOT NULL,
  name                    TEXT NOT NULL,
  diversity               TEXT NOT NULL,
  contact_number          TEXT NOT NULL,
  date_of_upload          TEXT NOT NULL,
  recruiter               TEXT NOT NULL,
  atci_vertical           TEXT NOT NULL,
  job_requisition_id      TEXT NOT NULL,
  role_name_primary_skill TEXT NOT NULL,
  management_level        TEXT NOT NULL,
  market                  TEXT NOT NULL,
  submitted_date_tracker  TEXT NOT NULL,
  status_recruiter        TEXT NOT NULL,
  remarks_status          TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version, description)
VALUES (
  '012',
  'candidate_master table (ATCI Candidate Master Data .xlsx → PostgreSQL, standalone)'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
