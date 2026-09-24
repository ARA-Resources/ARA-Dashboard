-- Migration 015: candidate_master Oorwin-sync column restructure
-- Idempotent: safe to run multiple times (each RENAME is guarded by an
-- information_schema check; ADD COLUMN uses IF NOT EXISTS).
--
-- Part of the Candidate Master Sheet Oorwin sync feature. Renames existing
-- columns to their new Oorwin-mapped names/semantics — no data is moved,
-- every renamed column keeps its existing values — and adds 3 new columns.
-- Dedup + field remap of the 11,951 existing rows into this new shape
-- happens separately, via scripts/migrate-candidate-master-to-oorwin-schema.ts,
-- after this migration has run. Does not touch lateral_master or
-- executive_master.
-- Run via: npm run db:migrate

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_master' AND column_name = 'diversity'
  ) THEN
    ALTER TABLE candidate_master RENAME COLUMN diversity TO gender;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_master' AND column_name = 'atci_vertical'
  ) THEN
    ALTER TABLE candidate_master RENAME COLUMN atci_vertical TO customer;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_master' AND column_name = 'recruiter'
  ) THEN
    ALTER TABLE candidate_master RENAME COLUMN recruiter TO submitter;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_master' AND column_name = 'remarks_status'
  ) THEN
    ALTER TABLE candidate_master RENAME COLUMN remarks_status TO submission_comments;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_master' AND column_name = 'role_name_primary_skill'
  ) THEN
    ALTER TABLE candidate_master RENAME COLUMN role_name_primary_skill TO primary_skills;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_master' AND column_name = 'management_level'
  ) THEN
    ALTER TABLE candidate_master RENAME COLUMN management_level TO job_management_level;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_master' AND column_name = 'submitted_date_tracker'
  ) THEN
    ALTER TABLE candidate_master RENAME COLUMN submitted_date_tracker TO submitted_date;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_master' AND column_name = 'status_recruiter'
  ) THEN
    ALTER TABLE candidate_master RENAME COLUMN status_recruiter TO status;
  END IF;
END $$;

-- cid, name, contact_number, date_of_upload, job_requisition_id, market
-- keep their existing names.

ALTER TABLE candidate_master
  ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '-',
  ADD COLUMN IF NOT EXISTS client_spoc TEXT NOT NULL DEFAULT '-',
  ADD COLUMN IF NOT EXISTS last_touched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_candidate_master_last_touched_at
  ON candidate_master (last_touched_at);

INSERT INTO schema_migrations (version, description)
VALUES (
  '015',
  'candidate_master Oorwin-sync column restructure (renames + email/client_spoc/last_touched_at)'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
