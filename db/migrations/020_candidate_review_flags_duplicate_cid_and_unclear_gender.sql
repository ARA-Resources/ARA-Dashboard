-- Migration 020: candidate_review_flags — new 'duplicate_cid' and
-- 'unclear_gender' reasons
-- Idempotent: safe to run multiple times (drops the constraint by name
-- before recreating it, guarded so a second run is a no-op).
--
-- Both reasons are written by the one-off candidate_master refresh script
-- (scripts/refresh-candidate-master-from-workbook.ts), not by the live
-- Oorwin sync engine:
--  - duplicate_cid: one flag row per row-member of ANY cid (other than the
--    '-' placeholder) that appears more than once in candidate_master,
--    regardless of whether the names agree — a strict superset of
--    duplicate_name_mismatch (which only fires on name disagreement).
--    Row-level, like duplicate_name_mismatch/invalid_candidate_id.
--  - unclear_gender: a row whose Gender value doesn't normalize to "Male",
--    "Female", or blank/"-" under the male/female alias rules. Field-level
--    (maps to the "Gender" header), like unclean_contact_number.
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
    'duplicate_cid',
    'duplicate_name_mismatch',
    'invalid_candidate_id',
    'jr_id_conflict',
    'legacy_contact_number_unclean',
    'missing_job_requisition_id',
    'unclean_contact_number',
    'unclear_gender'
  ));

INSERT INTO schema_migrations (version, description)
VALUES (
  '020',
  'candidate_review_flags: add duplicate_cid (row-level) and unclear_gender (field-level) reasons'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
