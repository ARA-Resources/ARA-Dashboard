-- Migration 022: Accenture Final Report upload support for the Candidate
-- Master Sheet (Stage 1 of 4 — schema only; no upload logic changes yet).
-- Idempotent: safe to run multiple times (IF NOT EXISTS everywhere).
--
-- Additive only. No existing row's meaning changes — every new column
-- defaults to a value meaning "not yet touched by an Accenture upload."
--
--  1. Five new candidate_master value columns, populated later by the
--     Accenture sync engine (Stage 2, not built yet):
--     accenture_candidate_stage, current_cid_source,
--     application_completion_status — written from the "Accenture Final
--     Report" upload. screening_candidate_stage, disposition_reason —
--     placeholders for a later, separate ATCI-screening-file stage, not
--     written by anything yet. All five default '-' (blank), matching this
--     table's existing "never SQL NULL" convention (see migration 012's
--     comment).
--  2. candidate_master.email_accenture_locked /
--     job_management_level_accenture_locked BOOLEAN — once an Accenture
--     upload writes a new value into email / job_management_level on a row,
--     the corresponding lock flips true and stays true forever (survives
--     manual edits) — a later Oorwin sync must fall back to the existing
--     stored value for that field on that row instead of overwriting it
--     from the sheet (Stage 2 extends candidate-sync-engine.ts's existing
--     conflictFields mechanism for this; not done in this migration).
--  3. candidate_master.last_accenture_sync_id BIGINT, nullable, FK to
--     candidate_sync_history(id) — the most recent Accenture run that
--     touched this row (matched or inserted), set unconditionally on every
--     touch regardless of whether any value changed. Backs three filters
--     (Stage 3): "ever touched" (IS NOT NULL), "latest upload" (= the newest
--     accenture_upload run's id), and — via a join to the ALREADY-EXISTING
--     inserted_sync_id column, no new column needed for this — "new rows
--     added by Accenture." Deliberately NOT a plain boolean: a boolean would
--     only answer "ever touched," duplicating what IS NOT NULL already
--     gives for free, while a reference also answers "touched by THIS run."
--  4. candidate_sync_history.kind gains an informal new value,
--     'accenture_upload' (column is plain nullable TEXT already, migration
--     021 — no CHECK constraint exists to alter here; Stage 2's code simply
--     starts writing that literal).
-- Run via: npm run db:migrate

BEGIN;

ALTER TABLE candidate_master
  ADD COLUMN IF NOT EXISTS accenture_candidate_stage TEXT NOT NULL DEFAULT '-',
  ADD COLUMN IF NOT EXISTS current_cid_source TEXT NOT NULL DEFAULT '-',
  ADD COLUMN IF NOT EXISTS application_completion_status TEXT NOT NULL DEFAULT '-',
  ADD COLUMN IF NOT EXISTS screening_candidate_stage TEXT NOT NULL DEFAULT '-',
  ADD COLUMN IF NOT EXISTS disposition_reason TEXT NOT NULL DEFAULT '-',
  ADD COLUMN IF NOT EXISTS email_accenture_locked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS job_management_level_accenture_locked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_accenture_sync_id BIGINT REFERENCES candidate_sync_history (id);

CREATE INDEX IF NOT EXISTS idx_candidate_master_last_accenture_sync_id
  ON candidate_master (last_accenture_sync_id) WHERE last_accenture_sync_id IS NOT NULL;

INSERT INTO schema_migrations (version, description)
VALUES (
  '022',
  'candidate_master Accenture Final Report columns (5 value columns, email/JML Accenture locks, last_accenture_sync_id reference) + candidate_sync_history.kind = ''accenture_upload'' (Stage 1: schema only)'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
