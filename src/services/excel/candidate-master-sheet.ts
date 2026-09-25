/**
 * Candidate Master Sheet — shared client/server types and small generic
 * helpers. Standalone: no imports from the lateral/executive equivalents.
 */

export const CANDIDATE_MASTER_PAGE_SIZE_OPTIONS = [
  10, 20, 50, 100, 250, 500,
] as const;

export type CandidateMasterPageSize =
  (typeof CANDIDATE_MASTER_PAGE_SIZE_OPTIONS)[number];

export const DEFAULT_CANDIDATE_MASTER_PAGE_SIZE: CandidateMasterPageSize = 20;

export type CandidateFilterControl =
  | "date"
  | "multi-select"
  | "searchable-multi-select"
  | "text";

export interface CandidateMasterFilterField {
  column: string;
  control: CandidateFilterControl;
  values: string[];
  valueCount: number;
}

export interface CandidateMasterDateFilter {
  from?: string;
  to?: string;
}

/**
 * C9 highlight/flag types a user can filter the table down to. "changed"
 * covers any field changed in a CID's most recent sync (candidate_sync_changes);
 * the rest mirror CandidateReviewFlagReason (candidate_review_flags).
 */
export const CANDIDATE_HIGHLIGHT_FILTER_OPTIONS = [
  { value: "changed", label: "Recently changed" },
  { value: "duplicate_name_mismatch", label: "Duplicate name" },
  { value: "invalid_candidate_id", label: "Invalid CID" },
  { value: "missing_job_requisition_id", label: "Missing JR ID" },
  { value: "jr_id_conflict", label: "JR conflict" },
  { value: "unclean_contact_number", label: "Unclean contact number" },
  { value: "legacy_contact_number_unclean", label: "Unclean contact number (legacy)" },
] as const;

export type CandidateHighlightFilterValue =
  (typeof CANDIDATE_HIGHLIGHT_FILTER_OPTIONS)[number]["value"];

export interface CandidateMasterSheetQuery {
  page: number;
  pageSize: CandidateMasterPageSize;
  columnFilters: Record<string, string[]>;
  textFilters: Record<string, string>;
  dateFilters: Record<string, CandidateMasterDateFilter>;
}

export function isCandidateRoleNameColumn(header: string): boolean {
  return header.trim() === "Primary Skills";
}

/** C10: the Candidate ID column is clickable — opens the full change-history popup. */
export function isCandidateIdColumn(header: string): boolean {
  return header.trim() === "Candidate ID";
}
