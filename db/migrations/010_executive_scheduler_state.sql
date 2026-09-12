-- Migration 010: executive_scheduler_state (Phase E1 — foundations only)
-- Idempotent: safe to run multiple times (IF NOT EXISTS / ON CONFLICT DO NOTHING)
-- Does NOT modify lateral_scheduler_state or any other existing table.
-- Does NOT arm any cron job — no code reads/writes this table yet outside
-- the new store methods added alongside this migration. Nothing live.
-- Run via: npm run db:migrate

BEGIN;

-- ============================================================
-- executive_scheduler_state
-- Single-row table for the Executive job scheduler configuration.
-- Mirrors lateral_scheduler_state's columns (migrations 001 + 005 combined
-- into one table from the start — no separate last_run_summary migration
-- needed since Executive has no legacy rows to migrate).
--
-- id is fixed to 1 (CHECK + PK, not SERIAL) so the seed/read pattern
-- `INSERT ... VALUES (1) ON CONFLICT (id) DO NOTHING` is genuinely
-- idempotent — a real UNIQUE target to conflict on, unlike
-- lateral_scheduler_state's `id SERIAL PRIMARY KEY` + `INSERT DEFAULT
-- VALUES ON CONFLICT DO NOTHING`, which has nothing to conflict against
-- (a fresh SERIAL id every time) and has been silently inserting a new
-- row on every read in prod (2,341 rows observed during E1 verification,
-- 2026-09-11 — pre-existing, NOT touched by this migration; flagged
-- separately, not fixed, since it's live Lateral behavior).
-- ============================================================
CREATE TABLE IF NOT EXISTS executive_scheduler_state (
  id               INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  frequency        TEXT NOT NULL DEFAULT 'daily',
  sync_time        TEXT NOT NULL DEFAULT '07:00',
  day_of_week      INT  NOT NULL DEFAULT 1,
  custom_days      JSONB NOT NULL DEFAULT '[1,2,3,4,5]',
  custom_times     JSONB NOT NULL DEFAULT '["09:00","11:00"]',
  timezone         TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  -- Phase E5: defaults FALSE (not TRUE like lateral_scheduler_state) so a
  -- fresh deploy never auto-fires the Executive pipeline without an explicit
  -- enable step. Combined with ARA_EXECUTIVE_SCHEDULER (unset = off) in
  -- scheduler-policy.ts — BOTH must be explicitly turned on before cron arms.
  -- Migration 010 has not been applied to production yet, so changing this
  -- default here is safe (does not violate "never edit an applied migration").
  enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  paused           BOOLEAN NOT NULL DEFAULT FALSE,
  last_run_at      TIMESTAMPTZ,
  last_run_status  TEXT,
  last_run_message TEXT,
  last_duration_ms INT,
  last_trigger     TEXT,
  last_run_summary JSONB,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the one and only row (id=1). Truly idempotent — re-running never
-- inserts a second row, since (id) is a real unique target.
INSERT INTO executive_scheduler_state (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO schema_migrations (version, description)
VALUES (
  '010',
  'executive_scheduler_state (Phase E1 foundations — no cron armed yet)'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
