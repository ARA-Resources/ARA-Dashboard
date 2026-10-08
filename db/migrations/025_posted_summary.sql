-- Migration 025: last_posted_summary — one additive nullable JSONB column
-- on each dataset's scheduler-state table, for the new "Posted" button.
-- Idempotent: safe to run multiple times (IF NOT EXISTS).
--
-- Why this exists: the Posted button (Lateral /dataset/lateral, Executive
-- /dataset/executive) needs a "Last Posted: <date time IST>, X Yes, Y not
-- posted" line on the dataset pages, independent of Run All's own
-- last_run_* columns on these same tables. It is written ONLY via its own
-- targeted `UPDATE ... SET last_posted_summary = $1` (see
-- lateral-posted-run.ts / executive-posted-run.ts, Stage 2) — never added
-- to writeLateral()/writeExecutive()'s explicit column list in
-- postgres-stores.ts, so Run All's own routine saves of this table can
-- never overwrite or erase it.
--
-- Shape (JSON, written by the app layer, not enforced here):
--   { ranAt, yes, notPosted, titleLinesRemoved, blankRowsRemoved,
--     needsLook, triggeredBy, previewOnly }
-- NULL until the Posted button has made its first REAL (non-preview) write.
BEGIN;

ALTER TABLE lateral_scheduler_state
  ADD COLUMN IF NOT EXISTS last_posted_summary JSONB;

ALTER TABLE executive_scheduler_state
  ADD COLUMN IF NOT EXISTS last_posted_summary JSONB;

INSERT INTO schema_migrations (version, description)
VALUES (
  '025',
  'lateral_scheduler_state.last_posted_summary + executive_scheduler_state.last_posted_summary — additive/nullable, written only by the new Posted button''s own targeted UPDATE, never by writeLateral()/writeExecutive()'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
