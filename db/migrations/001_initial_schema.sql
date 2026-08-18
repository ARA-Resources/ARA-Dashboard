-- Migration 001: Initial persistence schema for ARA Dashboard
-- Idempotent: safe to run multiple times (uses IF NOT EXISTS / ON CONFLICT DO NOTHING)
-- DO NOT run against production databases automatically.
-- Run via: npm run db:migrate

BEGIN;

-- ============================================================
-- gmail_checkpoint
-- Single-row table (one per account_email).
-- CRITICAL: used for deduplication of Gmail attachments.
-- Concurrent updates use optimistic locking via received_at_ms.
-- ============================================================
CREATE TABLE IF NOT EXISTS gmail_checkpoint (
  id               SERIAL PRIMARY KEY,
  account_email    TEXT NOT NULL DEFAULT 'default',
  message_id       TEXT,
  attachment_id    TEXT,
  received_at      TIMESTAMPTZ,
  received_at_ms   BIGINT,
  attachment_file  TEXT,
  drive_file_id    TEXT,
  processed_at     TIMESTAMPTZ,
  result           TEXT CHECK (result IS NULL OR result = 'SUCCESS'),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_email)
);

-- Seed the default account row so reads never miss
INSERT INTO gmail_checkpoint (account_email)
VALUES ('default')
ON CONFLICT (account_email) DO NOTHING;

-- ============================================================
-- app_config
-- Encrypted key-value store for secrets and configuration.
-- encrypted_value contains the full AES-256-GCM envelope JSON.
-- Keys: 'gmail_oauth', 'dataset_setup', 'lateral_processing_setup', 'dataset_drive_meta'
-- ============================================================
CREATE TABLE IF NOT EXISTS app_config (
  key              TEXT PRIMARY KEY,
  encrypted_value  TEXT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- lateral_scheduler_state
-- Single-row table for the Lateral job scheduler configuration.
-- ============================================================
CREATE TABLE IF NOT EXISTS lateral_scheduler_state (
  id               SERIAL PRIMARY KEY,
  frequency        TEXT NOT NULL DEFAULT 'daily',
  sync_time        TEXT NOT NULL DEFAULT '07:00',
  day_of_week      INT  NOT NULL DEFAULT 1,
  custom_days      JSONB NOT NULL DEFAULT '[1,2,3,4,5]',
  custom_times     JSONB NOT NULL DEFAULT '["09:00","11:00"]',
  timezone         TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  paused           BOOLEAN NOT NULL DEFAULT FALSE,
  last_run_at      TIMESTAMPTZ,
  last_run_status  TEXT,
  last_run_message TEXT,
  last_duration_ms INT,
  last_trigger     TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed single row
INSERT INTO lateral_scheduler_state DEFAULT VALUES
ON CONFLICT DO NOTHING;

-- ============================================================
-- dataset_scheduler_state
-- Global pause / timezone state for the multi-dataset scheduler.
-- ============================================================
CREATE TABLE IF NOT EXISTS dataset_scheduler_state (
  id             SERIAL PRIMARY KEY,
  global_paused  BOOLEAN NOT NULL DEFAULT FALSE,
  last_error     TEXT,
  timezone       TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO dataset_scheduler_state DEFAULT VALUES
ON CONFLICT DO NOTHING;

-- ============================================================
-- dataset_schedules
-- Per-dataset automation schedule definitions.
-- ============================================================
CREATE TABLE IF NOT EXISTS dataset_schedules (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  frequency       TEXT NOT NULL DEFAULT 'daily',
  sync_time       TEXT NOT NULL DEFAULT '09:00',
  day_of_week     INT  NOT NULL DEFAULT 1,
  custom_days     JSONB NOT NULL DEFAULT '[1,2,3,4,5]',
  custom_times    JSONB NOT NULL DEFAULT '["09:00"]',
  dataset_names   JSONB NOT NULL DEFAULT '[]',
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  paused          BOOLEAN NOT NULL DEFAULT FALSE,
  last_run_at     TIMESTAMPTZ,
  last_run_status TEXT,
  last_run_msg    TEXT,
  last_duration   INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- lateral_sync_history
-- Append-only audit log of Lateral pipeline runs.
-- ============================================================
CREATE TABLE IF NOT EXISTS lateral_sync_history (
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
CREATE INDEX IF NOT EXISTS idx_lateral_sync_history_sync_time
  ON lateral_sync_history (sync_time DESC);

-- ============================================================
-- dataset_sync_history
-- Append-only audit log of multi-dataset sync runs.
-- ============================================================
CREATE TABLE IF NOT EXISTS dataset_sync_history (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  trigger     TEXT,
  started_at  TIMESTAMPTZ NOT NULL,
  ended_at    TIMESTAMPTZ,
  duration_ms INT,
  items       JSONB NOT NULL DEFAULT '[]',
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dataset_sync_history_started_at
  ON dataset_sync_history (started_at DESC);

-- ============================================================
-- sync_watermark
-- Single-row: timestamp of last successful automated sync.
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_watermark (
  id                       SERIAL PRIMARY KEY,
  last_successful_sync_at  TIMESTAMPTZ,
  last_successful_sync_ms  BIGINT,
  last_trigger             TEXT,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO sync_watermark DEFAULT VALUES
ON CONFLICT DO NOTHING;

-- ============================================================
-- lateral_source_drive_state
-- Single-row: current source Drive file + cleanup queue.
-- ============================================================
CREATE TABLE IF NOT EXISTS lateral_source_drive_state (
  id                        SERIAL PRIMARY KEY,
  current_drive_file_id     TEXT,
  current_file_name         TEXT,
  current_message_id        TEXT,
  current_received_at       TIMESTAMPTZ,
  current_uploaded_at       TIMESTAMPTZ,
  pending_cleanup_file_ids  JSONB NOT NULL DEFAULT '[]',
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO lateral_source_drive_state DEFAULT VALUES
ON CONFLICT DO NOTHING;

-- ============================================================
-- home_metrics
-- Cached per-business-unit metrics snapshot.
-- One row per business_unit_id.
-- ============================================================
CREATE TABLE IF NOT EXISTS home_metrics (
  business_unit_id  TEXT PRIMARY KEY,
  totals            INT  NOT NULL DEFAULT 0,
  active            INT  NOT NULL DEFAULT 0,
  posted            INT  NOT NULL DEFAULT 0,
  fresh             INT  NOT NULL DEFAULT 0,
  file_name         TEXT NOT NULL DEFAULT '',
  mtime_ms          BIGINT NOT NULL DEFAULT 0,
  source            TEXT NOT NULL DEFAULT 'unknown',
  computed_at       TIMESTAMPTZ,
  error             TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- app_notifications
-- In-app notification feed (max 50, TTL managed by application).
-- ============================================================
CREATE TABLE IF NOT EXISTS app_notifications (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  href        TEXT,
  meta        JSONB,
  read        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_notifications_created_at
  ON app_notifications (created_at DESC);

-- ============================================================
-- sender_stats
-- Per-dataset per-sender Gmail attachment tracking.
-- ============================================================
CREATE TABLE IF NOT EXISTS sender_stats (
  id                   SERIAL PRIMARY KEY,
  dataset_name         TEXT NOT NULL,
  email                TEXT NOT NULL,
  last_email_received  TIMESTAMPTZ,
  total_emails         INT  NOT NULL DEFAULT 0,
  successful_syncs     INT  NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dataset_name, email)
);

-- ============================================================
-- lateral_p_roles_sheet_config
-- Stores the Google Spreadsheet ID used for P-Roles pivot.
-- ============================================================
CREATE TABLE IF NOT EXISTS lateral_p_roles_sheet_config (
  id                   SERIAL PRIMARY KEY,
  spreadsheet_id       TEXT,
  spreadsheet_name     TEXT,
  web_view_link        TEXT,
  seeded_from_file_id  TEXT,
  pivot_row_index      INT,
  pivot_col_index      INT,
  created_at           TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_pivot_applied   TIMESTAMPTZ,
  last_pivot_refreshed TIMESTAMPTZ
);
INSERT INTO lateral_p_roles_sheet_config DEFAULT VALUES
ON CONFLICT DO NOTHING;

-- ============================================================
-- schema_migrations
-- Migration version tracking.
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  description TEXT
);
INSERT INTO schema_migrations (version, description)
VALUES ('001', 'Initial persistence schema')
ON CONFLICT (version) DO NOTHING;

COMMIT;
