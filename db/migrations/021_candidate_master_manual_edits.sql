-- Migration 021: manual Add/Modify/Delete support for the Candidate Master
-- Sheet (candidate_master soft delete, row-precise change log, sync "kind").
-- Idempotent: safe to run multiple times (IF NOT EXISTS everywhere).
--
-- Three independent additions, all additive:
--  1. candidate_master.deleted_at / deleted_by — soft delete. A row with
--     deleted_at set is excluded from every read path (see
--     read-candidate-master.ts) but stays in the table for 30 days, purged
--     by the new candidate-purge-scheduler.ts. No existing row's meaning
--     changes (deleted_at defaults NULL = live, same as before this column
--     existed).
--  2. candidate_sync_changes.candidate_master_id — the exact row a change
--     row belongs to, not just its CID. Existing rows (candidate_sync_changes
--     is append-only, never pruned) are left NULL — genuinely unknown, no
--     backfill attempted, same policy as migration 019's inserted_sync_id.
--     No FK: candidate_master rows can be hard-deleted by the purge job,
--     and the change row must survive that (audit trail outlives the row).
--  3. candidate_sync_history.kind — distinguishes a real Oorwin Upload
--     ('oorwin_upload') from a manual Add/Modify ('manual_add' /
--     'manual_modify') from a one-off script/legacy run (NULL). Backfilled
--     on existing rows using the one live signal available: a real Upload's
--     triggered_by is always the uploading user's email/username (set from
--     gate.user in oorwin-sync/route.ts), which no script-driven run ever
--     has. Drives the "Recently changed" fix (latest Upload + any manual
--     edits since it, instead of "every CID ever changed, forever").
-- Run via: npm run db:migrate

BEGIN;

ALTER TABLE candidate_master
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;

CREATE INDEX IF NOT EXISTS idx_candidate_master_deleted_at
  ON candidate_master (deleted_at) WHERE deleted_at IS NOT NULL;

ALTER TABLE candidate_sync_changes
  ADD COLUMN IF NOT EXISTS candidate_master_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_candidate_sync_changes_candidate_master_id
  ON candidate_sync_changes (candidate_master_id);

ALTER TABLE candidate_sync_history
  ADD COLUMN IF NOT EXISTS kind TEXT;

-- Backfill: mark every existing history row whose triggered_by looks like a
-- real user identity (contains "@") as 'oorwin_upload' — the only path that
-- sets triggered_by from an authenticated user (oorwin-sync/route.ts).
-- Script-driven rows (legacy-migration-script, backfill-script,
-- refresh-candidate-master-from-workbook.ts --apply, ...) never match this
-- and are left NULL, same as any future one-off script run.
UPDATE candidate_sync_history
  SET kind = 'oorwin_upload'
  WHERE kind IS NULL AND triggered_by LIKE '%@%';

INSERT INTO schema_migrations (version, description)
VALUES (
  '021',
  'candidate_master soft delete (deleted_at/deleted_by) + candidate_sync_changes.candidate_master_id + candidate_sync_history.kind, for manual Add/Modify/Delete'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
