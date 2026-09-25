-- Migration 019: candidate_master.inserted_sync_id
-- Idempotent: safe to run multiple times (ADD COLUMN/INDEX use IF NOT EXISTS).
--
-- Additive, nullable column recording which sync run (candidate_sync_history)
-- INSERTED a given candidate_master row. Never set/updated on an existing
-- row's later update — that's what candidate_sync_changes already tracks.
-- Existing rows (everything inserted before this column existed) are left
-- NULL — genuinely unknown, no backfill attempted.
--
-- Why this is needed: candidate_sync_changes only logs field-level UPDATEs
-- (see candidate-sync-engine.ts), never inserts. Without this column, "which
-- rows did sync N touch" could only be answered for updates/flags, silently
-- missing every row that sync inserted — the common case for a real Oorwin
-- upload (see the Candidate Master Sheet "filter by sync" feature plan).
-- Run via: npm run db:migrate

BEGIN;

ALTER TABLE candidate_master
  ADD COLUMN IF NOT EXISTS inserted_sync_id BIGINT REFERENCES candidate_sync_history (id);

CREATE INDEX IF NOT EXISTS idx_candidate_master_inserted_sync_id
  ON candidate_master (inserted_sync_id);

INSERT INTO schema_migrations (version, description)
VALUES (
  '019',
  'candidate_master.inserted_sync_id — tracks which sync run inserted each row'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
