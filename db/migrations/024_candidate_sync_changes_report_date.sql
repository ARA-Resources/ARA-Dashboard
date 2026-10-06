-- Migration 024: candidate_sync_changes.report_date — one additive nullable
-- column, for the Accenture replay engine's history display.
-- Idempotent: safe to run multiple times (IF NOT EXISTS).
--
-- Why this exists: the replay engine stamps the ONE step per (cid, field)
-- per run that actually writes the live `candidate_master` column with a
-- REAL timestamp (not the backdated file date) — see candidate-accenture-
-- replay-engine.ts's module doc comment, "LATEST-WRITER ORDERING" — so
-- that `changed_at DESC, id DESC` correctly identifies the true latest
-- writer for violet/hover purposes even once some steps are backdated.
-- That is correct for ORDERING, but it means `changed_at` is no longer
-- usable as the step's DISPLAY date for that one step: the Candidate
-- History modal would show today's upload time instead of the file's
-- real report date for the most recent entry, the one a reviewer is most
-- likely to look at. `report_date` ("YYYY-MM-DD" TEXT, matching this
-- table's sibling candidate_master.last_accenture_report_date from
-- migration 023) is set for EVERY replay-mode step — backdated or
-- real-time-stamped alike — to that step's true file date, independent
-- of whatever `changed_at` holds for ordering purposes. NULL for every
-- classic-engine step and every Oorwin/manual edit, where it doesn't
-- apply (changed_at already is the real, correct display date there).
BEGIN;

ALTER TABLE candidate_sync_changes
  ADD COLUMN IF NOT EXISTS report_date TEXT;

INSERT INTO schema_migrations (version, description)
VALUES (
  '024',
  'candidate_sync_changes.report_date — true file report date per step, independent of changed_at (which the replay engine''s one live-write step per run stamps with real time for ordering), additive/nullable'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
