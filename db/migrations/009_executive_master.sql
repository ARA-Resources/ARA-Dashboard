-- Migration 009: executive_master table (Excel → PostgreSQL, mirrors lateral_master)
-- Idempotent: safe to run multiple times (IF NOT EXISTS / ON CONFLICT DO NOTHING)
-- Does NOT modify existing application tables.
-- Does NOT delete Master rows (no DELETE statements).
-- Does NOT import Excel data or change application logic.
-- Run via: npm run db:migrate

BEGIN;

-- ============================================================
-- executive_master
-- Executive Master dataset (replaces the Executive XLSM Master Sheet as storage
-- for the Accenture Dashboard's Executive tab). Same shape as lateral_master.
-- Business key: job_requisition_id  (all "ATCI-" prefixed, unique)
-- posted stays workbook-compatible: "Yes" | "-"
-- job_status values (enforced when present): New | Reopen | Active | Closed
-- Executive uses a 5/6/7 Job Management Level scale (7-Manager / 6-Senior Manager
-- / 5-Associate Director) — stored verbatim, no scale enforced here.
-- priority is free TEXT (normalized in application code, no CHECK — parity with
-- lateral_master.priority).
-- Source "Active Pipeline" column is intentionally NOT stored.
-- Team*, yrs of Experience, Ageing Slab, Opened on Oorwin, etc. are intentionally
-- omitted (not in the 13-column import).
-- ============================================================
CREATE TABLE IF NOT EXISTS executive_master (
  job_requisition_id     TEXT        NOT NULL,
  date                   DATE,
  market_map             TEXT,
  primary_skills         TEXT,
  primary_location       TEXT,
  job_management_level   TEXT,
  must_have_skills       TEXT,
  location_flex          TEXT,
  skill_categorization   TEXT,
  job_description        TEXT,
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
  priority               TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at           TIMESTAMPTZ,
  PRIMARY KEY (job_requisition_id)
);

-- PK already covers job_requisition_id uniqueness / lookups.
-- Secondary indexes for common dashboard / reconcile filters.
CREATE INDEX IF NOT EXISTS idx_executive_master_job_status
  ON executive_master (job_status);

CREATE INDEX IF NOT EXISTS idx_executive_master_posted
  ON executive_master (posted);

CREATE INDEX IF NOT EXISTS idx_executive_master_last_seen_at
  ON executive_master (last_seen_at);

INSERT INTO schema_migrations (version, description)
VALUES (
  '009',
  'executive_master table (Executive XLSM Master Sheet → PostgreSQL foundation)'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
