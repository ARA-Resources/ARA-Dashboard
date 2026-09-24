-- Migration 018: candidate_review_flags — new 'invalid_candidate_id' and
-- 'missing_job_requisition_id' reasons
-- Idempotent: safe to run multiple times (drops the constraint by name
-- before recreating it, guarded so a second run is a no-op).
--
-- Adds two more reason values for the Candidate Master Sheet Oorwin sync
-- feature's review-flag table, both live-sync-only (never written by the
-- one-time legacy migration script):
--  - invalid_candidate_id: a live sync row whose Candidate ID doesn't match
--    "C" followed by one or more digits (e.g. a phone number or free-text
--    value landed in the CID column). Unlike unclean_contact_number, this
--    is a QUARANTINE reason — the row is excluded from candidate_master
--    entirely (same mechanism as duplicate_name_mismatch), never
--    inserted/updated, because CID is the sole matching key for all future
--    syncs and an untrustworthy CID can never be reliably re-matched.
--  - missing_job_requisition_id: a live sync row whose Job Requisition ID
--    is blank/"-". Unlike invalid_candidate_id, this does NOT block
--    insert/update — JR ID doesn't participate in matching, so the row is
--    still stored (same flag-only philosophy as unclean_contact_number).
--    Blank JR ID is normal/expected on the one-time legacy migration (JR ID
--    didn't exist pre-Oorwin) — this reason is live-sync only, matching the
--    live/legacy split already established by
--    unclean_contact_number/legacy_contact_number_unclean.
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
    'invalid_candidate_id',
    'jr_id_conflict',
    'legacy_contact_number_unclean',
    'missing_job_requisition_id',
    'unclean_contact_number'
  ));

INSERT INTO schema_migrations (version, description)
VALUES (
  '018',
  'candidate_review_flags: add invalid_candidate_id (quarantine) and missing_job_requisition_id (flag) reasons'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
