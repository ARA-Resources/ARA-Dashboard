-- Migration 016: candidate_sync_changes / candidate_review_flags / candidate_sync_history
-- Idempotent: safe to run multiple times (IF NOT EXISTS).
--
-- Supports the Candidate Master Sheet Oorwin sync feature:
--  - candidate_sync_history: one row per sync run (Oorwin file upload, or
--    the one-time legacy migration script). Created at run start
--    (started_at set, result/finished_at filled in once the run completes),
--    mirrors lateral_sync_history / executive_sync_history's shape.
--  - candidate_sync_changes: append-only per-field change log, sync_id FK to
--    candidate_sync_history. Drives both the "changed in the most recent
--    sync" dashboard highlight (filtered to the latest sync_id per CID) and
--    the full per-candidate history popup (unfiltered, all syncs) — same
--    table, two different queries. Never pruned.
--  - candidate_review_flags: rows needing manual review — a duplicate CID
--    within one incoming sheet whose names don't match
--    (duplicate_name_mismatch), a Job Requisition ID found with conflicting
--    data in both lateral_master and executive_master (jr_id_conflict), or
--    a legacy contact_number that didn't cleanly reformat to 10 digits
--    during the one-time migration (legacy_contact_number_unclean, sync_id
--    NULL — not tied to a live sync run).
-- Run via: npm run db:migrate

BEGIN;

CREATE TABLE IF NOT EXISTS candidate_sync_history (
  id                 BIGSERIAL PRIMARY KEY,
  started_at         TIMESTAMPTZ NOT NULL,
  finished_at        TIMESTAMPTZ,
  result             TEXT NOT NULL CHECK (result IN ('success', 'partial', 'failed')),
  source_filename    TEXT,
  triggered_by       TEXT,
  rows_in_sheet      INT NOT NULL DEFAULT 0,
  inserted_count     INT NOT NULL DEFAULT 0,
  updated_count      INT NOT NULL DEFAULT 0,
  unchanged_count    INT NOT NULL DEFAULT 0,
  quarantined_count  INT NOT NULL DEFAULT 0,
  review_flag_count  INT NOT NULL DEFAULT 0,
  failure_reason     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_candidate_sync_history_started_at
  ON candidate_sync_history (started_at DESC);

CREATE TABLE IF NOT EXISTS candidate_sync_changes (
  id          BIGSERIAL PRIMARY KEY,
  sync_id     BIGINT REFERENCES candidate_sync_history (id),
  cid         TEXT NOT NULL,
  field_name  TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_candidate_sync_changes_cid
  ON candidate_sync_changes (cid);
CREATE INDEX IF NOT EXISTS idx_candidate_sync_changes_sync_id
  ON candidate_sync_changes (sync_id);

CREATE TABLE IF NOT EXISTS candidate_review_flags (
  id          BIGSERIAL PRIMARY KEY,
  sync_id     BIGINT REFERENCES candidate_sync_history (id),
  cid         TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN (
                'duplicate_name_mismatch',
                'jr_id_conflict',
                'legacy_contact_number_unclean'
              )),
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_candidate_review_flags_cid
  ON candidate_review_flags (cid);
CREATE INDEX IF NOT EXISTS idx_candidate_review_flags_reason
  ON candidate_review_flags (reason);

INSERT INTO schema_migrations (version, description)
VALUES (
  '016',
  'candidate_sync_changes / candidate_review_flags / candidate_sync_history (Oorwin sync)'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
