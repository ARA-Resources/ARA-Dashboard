-- Migration 002: OAuth state table for Vercel-safe Gmail OAuth flow
-- Idempotent: safe to run multiple times (IF NOT EXISTS / ON CONFLICT DO NOTHING)
-- Replaces file-based gmail-oauth-state.enc.json when ARA_PERSISTENCE=postgres.
--
-- Design:
--   - Each OAuth attempt inserts its own row keyed by state_token (UUID hex).
--   - Concurrent flows never collide because each has a unique token.
--   - Consumed tokens are deleted atomically in a single DELETE...RETURNING.
--   - Expired rows (>1h past expires_at) are purged opportunistically on insert.

BEGIN;

CREATE TABLE IF NOT EXISTS oauth_state (
  state_token     TEXT        PRIMARY KEY,
  expected_email  TEXT        NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_state_expires_at
  ON oauth_state (expires_at);

INSERT INTO schema_migrations (version, description)
VALUES ('002', 'OAuth state table for Vercel-safe Gmail OAuth')
ON CONFLICT (version) DO NOTHING;

COMMIT;
