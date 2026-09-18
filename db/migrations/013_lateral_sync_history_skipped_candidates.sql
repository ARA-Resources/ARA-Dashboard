-- Migration 013: lateral_sync_history skipped-candidate visibility
-- Idempotent: safe to run multiple times (IF NOT EXISTS).
-- Purely additive — does not touch the existing result CHECK constraint
-- ('Success'/'Failed') or any other column.
--
-- Supports the Lateral Gmail-sync "continue to next candidate" fix: a run
-- that skipped a recoverable, content-specific failure (bad file, missing
-- ATCI DS) before succeeding on a later candidate still reports
-- result='Success' (the real file WAS found and processed), but must not
-- look identical to an unremarkable, nothing-happened success. These
-- columns carry that detail without changing the binary result semantics.
-- Run via: npm run db:migrate

BEGIN;

ALTER TABLE lateral_sync_history
  ADD COLUMN IF NOT EXISTS skipped_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_detail JSONB;

INSERT INTO schema_migrations (version, description)
VALUES (
  '013',
  'lateral_sync_history skipped-candidate visibility (skipped_count, skipped_detail)'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
