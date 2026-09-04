-- Migration 005: Persist Lateral Run All last-run summary for Master Sheet banner
-- Stores Adhoc DS date / result / counts on lateral_scheduler_state.
-- Idempotent. Does not alter lateral_master data.

BEGIN;

ALTER TABLE lateral_scheduler_state
  ADD COLUMN IF NOT EXISTS last_run_summary JSONB;

COMMENT ON COLUMN lateral_scheduler_state.last_run_summary IS
  'Last Lateral Run All summary for Master Sheet banner (result, Adhoc DS date, counts)';

INSERT INTO schema_migrations (version, description)
VALUES (
  '005',
  'lateral_scheduler_state.last_run_summary for Master Sheet last-run banner'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
