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

export interface CandidateMasterSheetQuery {
  page: number;
  pageSize: CandidateMasterPageSize;
  columnFilters: Record<string, string[]>;
  textFilters: Record<string, string>;
  dateFilters: Record<string, CandidateMasterDateFilter>;
}

export function isCandidateRoleNameColumn(header: string): boolean {
  return header.trim() === "Role Name/Primary Skill";
}
