-- Migration 007: invites.created_at — reconcile live schema with Phase 3 code
--
-- WHY THIS EXISTS
-- The live `invites` table was created on 2026-09-04 by an EARLIER build of
-- migration 006 (schema_migrations shows 006 applied at 2026-09-04 11:56 with a
-- different description than 006's current file text). 006 was later edited in
-- place; because it uses CREATE TABLE IF NOT EXISTS and
-- `INSERT INTO schema_migrations ... ON CONFLICT DO NOTHING`, re-running it was a
-- silent no-op and the table never picked up the newer definition.
--
-- The live table is missing `created_at`. Phase 3 code
-- (src/lib/auth/invites-db.ts) references `invites.created_at` in its
-- `INSERT ... RETURNING` and in `listRecentInvites()`, so `POST /api/admin/invites`
-- fails outright without this column.
--
-- SCOPE
-- Adds the one missing column and nothing else. Does NOT drop/recreate the
-- table, and does NOT touch the `created_by` NOT NULL / ON DELETE RESTRICT
-- discrepancy — the Phase 3 code always inserts a real super_admin UUID for
-- `created_by` and never deletes users, so that discrepancy is currently inert.
--
-- SAFETY
-- ADD COLUMN IF NOT EXISTS is idempotent. The DEFAULT backfills existing rows
-- (there are none yet). At this table size any rewrite is instant.

BEGIN;

ALTER TABLE invites
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

INSERT INTO schema_migrations (version, description)
VALUES ('007', 'invites.created_at — reconcile live schema with Phase 3 code')
ON CONFLICT (version) DO NOTHING;

COMMIT;
