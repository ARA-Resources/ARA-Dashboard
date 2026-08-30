-- Migration 003: Lateral Master + Staging tables (Excel → PostgreSQL foundation)
-- Idempotent: safe to run multiple times (IF NOT EXISTS / ON CONFLICT DO NOTHING)
-- Does NOT modify existing application tables.
-- Does NOT delete Master rows (no DELETE statements).
-- Does NOT import Excel data or change application logic.
-- Run via: npm run db:migrate

BEGIN;

-- ============================================================
-- lateral_master
-- Business Master dataset (replaces Excel Master Sheet as storage).
-- Business key: job_requisition_id
-- posted remains workbook-compatible: "Yes" | "-"
-- job_status values (enforced when present): New | Reopen | Active | Closed
-- Excel-only columns (Team*, Opened on Oorwin, etc.) are intentionally omitted.
-- ============================================================
CREATE TABLE IF NOT EXISTS lateral_master (
  job_requisition_id     TEXT        NOT NULL,
  date                   DATE,
  priority               TEXT,
  job_description        TEXT,
  skill_categorization   TEXT,
  primary_skills         TEXT,
  job_management_level   TEXT,
  primary_location       TEXT,
  market_map             TEXT,
  poc                    TEXT,
  job_status             TEXT
    CHECK (
      job_status IS NULL
      OR job_status IN ('New', 'Reopen', 'Active', 'Closed')
    ),
  posted                 TEXT
    CHECK (
      posted IS NULL
      OR posted IN ('Yes', '-')
    ),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at           TIMESTAMPTZ,
  PRIMARY KEY (job_requisition_id)
);

-- PK already covers job_requisition_id uniqueness / lookups.
-- Secondary indexes for common dashboard / reconcile filters.
CREATE INDEX IF NOT EXISTS idx_lateral_master_job_status
  ON lateral_master (job_status);

CREATE INDEX IF NOT EXISTS idx_lateral_master_posted
  ON lateral_master (posted);

CREATE INDEX IF NOT EXISTS idx_lateral_master_last_seen_at
  ON lateral_master (last_seen_at);

-- ============================================================
-- lateral_staging
-- Current-run ATCI DS / New Sheet equivalent.
-- Truncated and replaced on each successful import (application-owned).
-- Does NOT store job_status.
-- id is operational row identity only (source may have duplicate JRs).
-- ============================================================
CREATE TABLE IF NOT EXISTS lateral_staging (
  id                     BIGSERIAL   PRIMARY KEY,
  date                   DATE,
  job_requisition_id     TEXT        NOT NULL,
  priority               TEXT,
  job_description        TEXT,
  skill_categorization   TEXT,
  primary_skills         TEXT,
  job_management_level   TEXT,
  primary_location       TEXT,
  market_map             TEXT,
  poc                    TEXT
);

CREATE INDEX IF NOT EXISTS idx_lateral_staging_job_requisition_id
  ON lateral_staging (job_requisition_id);

INSERT INTO schema_migrations (version, description)
VALUES (
  '003',
  'Lateral Master + Staging tables (Excel → PostgreSQL foundation)'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
