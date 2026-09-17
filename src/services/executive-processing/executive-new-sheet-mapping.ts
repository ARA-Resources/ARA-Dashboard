/**
 * Base DS (via `executive-base-ds-mapping.ts`) -> real Master Workbook
 * "New Sheet" tab column translation.
 *
 * Confirmed current "New Sheet" header (re-fetched fresh 2026-09-17, after
 * the file's owner manually removed the tab's old blank spacer columns and
 * "Variable 1"/"Variable 2" formula columns): 11 plain columns, no formulas,
 * no trailing padding to account for. This supersedes an earlier, now-void
 * 15-column reading of this same tab.
 *
 * "Posted" is deliberately never populated here from Base DS — it isn't a
 * Base DS field at all, and stays blank/untouched by this mapping. It is
 * only ever written by the Posted Sheet decision, and only onto Master
 * Sheet (see `executive-posted-refresh.ts` / the Master Sheet writer) — New
 * Sheet's own Posted column is left exactly as Excel clears it on each run.
 */
import type { ExecutiveMappedRow } from "@/services/executive-processing/executive-base-ds-mapping";

export const EXECUTIVE_NEW_SHEET_HEADERS = [
  "Job Requisition ID",
  "Market",
  "Primary Skill",
  "Primary Location",
  "Level",
  "Must Have skills",
  "Location Flex",
  "Skill category",
  "Job Description",
  "Priority",
  "Posted",
] as const;

export type ExecutiveNewSheetHeader =
  (typeof EXECUTIVE_NEW_SHEET_HEADERS)[number];

/**
 * Translate one already-mapped Base DS row (keyed by executive_master field
 * names) into an ordered array of cell values matching
 * {@link EXECUTIVE_NEW_SHEET_HEADERS}. "Posted" is always null.
 */
export function mapExecutiveRowToNewSheetRow(
  row: ExecutiveMappedRow
): Array<string | null> {
  return [
    row.jobRequisitionId,
    row.values.market_map,
    row.values.primary_skills,
    row.values.primary_location,
    row.values.job_management_level,
    row.values.must_have_skills,
    row.values.location_flex,
    row.values.skill_categorization,
    row.values.job_description,
    row.values.priority,
    null, // Posted — never written here, see module doc comment.
  ];
}

/**
 * Translate a full batch of mapped Base DS rows into New Sheet data rows,
 * in the same order they were given (caller controls ordering, e.g.
 * preserving Base DS source order).
 */
export function mapExecutiveRowsToNewSheetRows(
  rows: ExecutiveMappedRow[]
): Array<Array<string | null>> {
  return rows.map(mapExecutiveRowToNewSheetRow);
}
