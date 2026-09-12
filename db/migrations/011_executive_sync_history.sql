-- Migration 011: executive_sync_history (Phase E8 — Dataset Manager UI)
-- Idempotent: safe to run multiple times (IF NOT EXISTS)
-- Does NOT modify lateral_sync_history or any other existing table.
-- Run via: npm run db:migrate

BEGIN;

-- ============================================================
-- executive_sync_history
-- Append-only audit log of Executive pipeline runs (invokeExecutiveJob).
-- Column-for-column mirror of lateral_sync_history — same shape, own table,
-- own store class (PostgresExecutiveSyncHistoryStore), never shares rows
-- with Lateral's history.
-- ============================================================
CREATE TABLE IF NOT EXISTS executive_sync_history (
  id                   TEXT PRIMARY KEY,
  sync_time            TIMESTAMPTZ NOT NULL,
  source_email         TEXT NOT NULL DEFAULT '—',
  original_filename    TEXT NOT NULL DEFAULT '—',
  drive_file_id        TEXT NOT NULL DEFAULT '—',
  rows_imported        INT  NOT NULL DEFAULT 0,
  new_count            INT  NOT NULL DEFAULT 0,
  active_count         INT  NOT NULL DEFAULT 0,
  reopen_count         INT  NOT NULL DEFAULT 0,
  closed_count         INT  NOT NULL DEFAULT 0,
  result               TEXT NOT NULL CHECK (result IN ('Success', 'Failed')),
  error                TEXT,
  trigger              TEXT,
  duration_ms          INT  NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_executive_sync_history_sync_time
  ON executive_sync_history (sync_time DESC);

INSERT INTO schema_migrations (version, description)
VALUES (
  '011',
  'executive_sync_history (Phase E8 — Dataset Manager UI sync log)'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
