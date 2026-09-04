-- Migration 004: Extend lateral_master for full Excel Master Sheet columns
-- Adds Excel-only column omitted by migration 003: "Opened on Oorwin"
-- Idempotent: ADD COLUMN IF NOT EXISTS
-- Does NOT drop columns, delete rows, or change PK / existing CHECKs.
-- Run via: npm run db:migrate

BEGIN;

ALTER TABLE lateral_master
  ADD COLUMN IF NOT EXISTS opened_on_oorwin TEXT;

COMMENT ON COLUMN lateral_master.opened_on_oorwin IS
  'Excel Master Sheet header: Opened on Oorwin (free text; not a date)';

INSERT INTO schema_migrations (version, description)
VALUES (
  '004',
  'lateral_master: add opened_on_oorwin for full Excel column coverage'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
