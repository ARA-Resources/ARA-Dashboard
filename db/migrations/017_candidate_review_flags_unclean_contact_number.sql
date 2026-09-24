-- Migration 017: candidate_review_flags — new 'unclean_contact_number' reason
-- Idempotent: safe to run multiple times (drops the constraint by name
-- before recreating it, guarded so a second run is a no-op).
--
-- Adds a 4th reason value for the Candidate Master Sheet Oorwin sync
-- feature's review-flag table: a LIVE sync row whose Mobile doesn't
-- cleanly reduce to 10 digits now also gets flagged, same as the one-time
-- legacy migration's 'legacy_contact_number_unclean' already does — but as
-- its own distinct reason ('unclean_contact_number'), not reused, since one
-- is a one-time historical-data flag and the other is an ongoing live-sync
-- data-quality flag.
--
-- Display note for C9 (highlighting UI, not yet built): candidate_review_flags
-- is intentionally append-only — a jr_id_conflict or unclean_contact_number
-- flag is written EVERY sync run the underlying issue recurs (same
-- philosophy as candidate_sync_changes), so a persistently-unresolved issue
-- accumulates multiple rows over time. The dashboard must show only rows
-- from the MOST RECENT sync_id per (cid, reason) — NOT a naive
-- DISTINCT ON (cid, reason), which would wrongly collapse a CID with two
-- simultaneous conflicting fields (e.g. both job_management_level AND
-- market) down to just one. Find MAX(sync_id) per (cid, reason) first, then
-- join back for every row matching that exact (cid, reason, sync_id) — see
-- the full query in candidate-sync-engine.ts's doc comment. Full history
-- stays queryable (unfiltered) for the candidate history popup.
-- Run via: npm run db:migrate

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'candidate_review_flags_reason_check'
  ) THEN
    ALTER TABLE candidate_review_flags DROP CONSTRAINT candidate_review_flags_reason_check;
  END IF;
END $$;

ALTER TABLE candidate_review_flags
  ADD CONSTRAINT candidate_review_flags_reason_check CHECK (reason IN (
    'duplicate_name_mismatch',
    'jr_id_conflict',
    'legacy_contact_number_unclean',
    'unclean_contact_number'
  ));

INSERT INTO schema_migrations (version, description)
VALUES (
  '017',
  'candidate_review_flags: add unclean_contact_number reason for live-sync Mobile flagging'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
