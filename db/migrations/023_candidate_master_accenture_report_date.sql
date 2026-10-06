-- Migration 023: candidate_master.last_accenture_report_date — one additive
-- nullable column, for the Accenture replay engine's idempotency (dated
-- Master Sheet uploads, candidate-accenture-replay-engine.ts).
-- Idempotent: safe to run multiple times (IF NOT EXISTS).
--
-- Why this exists: a (cid, field) pair's "already replayed through" date
-- was meant to be fully DERIVABLE from candidate_sync_changes (the latest
-- accenture_upload-sourced step for that field, no new state needed) — see
-- the plan this was built from. That works whenever a run logs at least
-- one real step for a field. It silently fails for a CID/field a run
-- touched but found ZERO real change for (the file's reported value
-- already matched what was stored): no step is ever logged for that field
-- in that run (by design — "one row per REAL step"), so there is NO
-- history row to derive a checkpoint from, even though the run DID fully
-- consider every occurrence through that run's file's last date for that
-- CID. Without this column, re-uploading the same (or an overlapping)
-- file would re-walk those same already-seen occurrences from whatever
-- the field's CURRENT live value happens to be — which may by then be a
-- later, unrelated manual edit — producing a spurious step/write that
-- never should have happened.
--
-- `last_accenture_report_date` is set UNCONDITIONALLY on every touch
-- (matched or inserted), same discipline as the already-existing
-- `last_accenture_sync_id` (migration 022) — to this CID's own LAST report
-- date within the uploaded file (not the whole file's last date; 2,051 of
-- the first load's 3,214 CIDs are absent from the file's own last report
-- date, so "this CID's last appearance" and "the file's last date" are
-- often different). Stored as "YYYY-MM-DD" TEXT (matching this table's
-- existing text-for-dates convention, migration 012's comment) rather than
-- a real DATE column — the replay engine already has this value as a
-- plain string from candidate-excel-date.ts's `accentureReportDateKey`.
--
-- When a field has no per-field checkpoint (no step ever logged) but this
-- column IS set, the replay engine treats it as "every occurrence through
-- this date was already considered for every field on this CID" and skips
-- them uniformly, falling back to the live column's current value as the
-- seed — exactly the CID-level backstop the per-field, step-derived
-- checkpoint above is missing on its own.
BEGIN;

ALTER TABLE candidate_master
  ADD COLUMN IF NOT EXISTS last_accenture_report_date TEXT;

INSERT INTO schema_migrations (version, description)
VALUES (
  '023',
  'candidate_master.last_accenture_report_date — CID-level replay checkpoint backstop for the Accenture replay engine, additive/nullable'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
