-- Migration 014: gmail_checkpoint recent-fingerprint history
-- Idempotent: safe to run multiple times (IF NOT EXISTS).
-- Purely additive — does not touch the existing message_id/attachment_id/
-- received_at_ms cursor columns or the result CHECK constraint.
--
-- Supports the Lateral Gmail-sync duplicate-content fix (2026-09-21): the
-- single (receivedAtMs, messageId) cursor cannot recognize a same-content
-- duplicate arriving under a DIFFERENT Gmail messageId (e.g. a forwarded
-- copy of an already-processed attachment). This column stores a small,
-- bounded (last 25, app-enforced) history of recently-processed
-- filename+size fingerprints so such duplicates can be excluded from
-- discovery regardless of which messageId carries them.
-- Run via: npm run db:migrate

BEGIN;

ALTER TABLE gmail_checkpoint
  ADD COLUMN IF NOT EXISTS recent_fingerprints JSONB NOT NULL DEFAULT '[]';

INSERT INTO schema_migrations (version, description)
VALUES (
  '014',
  'gmail_checkpoint recent-fingerprint history (recent_fingerprints)'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
