-- Migration 008: users — password_changed_at + avatar_color (Phase 4)
--
-- password_changed_at: set to NOW() whenever a user changes their own password.
-- proxy.ts / the DAL reject any session token minted BEFORE this timestamp, so a
-- password change signs out every other active session (the changer's own
-- session is re-issued a fresh cookie by the endpoint).
-- NULL = never changed → all existing tokens remain valid.
--
-- avatar_color: one of a small fixed palette (see src/lib/auth/avatar.ts), used
-- with initials for the profile avatar. NULL = derive a stable colour from email.
--
-- Idempotent. No table rewrite (both columns nullable, no default).

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_color TEXT;

INSERT INTO schema_migrations (version, description)
VALUES ('008', 'users: password_changed_at + avatar_color (Phase 4)')
ON CONFLICT (version) DO NOTHING;

COMMIT;
