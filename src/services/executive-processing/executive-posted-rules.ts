/**
 * Executive Posted Sheet → Master Sheet Posted (Yes / -).
 *
 * Inspected Executive workbook Posted Sheet headers (Aug 21 XLSM):
 *   A: "Posted  Jobs"  (posting text: JR | Posting Date: … | Location)
 *   B: "Job Requisition ID"
 *   C: "Demand" (Yes/No vs Master — VBA helper; not Master Posted itself)
 *
 * Master Sheet Posted (Column N) business behavior (Lateral-parity / VBA PostedJobs):
 *   JR present in Posted Sheet → "Yes"
 *   else → "-"
 *
 * Do NOT convert "-" to "No".
 */

export const EXECUTIVE_POSTED_SHEET_NAME = "Posted Sheet";
export const EXECUTIVE_POSTED_JR_HEADER = "Job Requisition ID";
export const EXECUTIVE_POSTED_POSTING_HEADER = "Posted  Jobs";
export const EXECUTIVE_MASTER_POSTED_HEADER = "Posted";

export type ExecutivePostedValue = "Yes" | "-";

/**
 * Extract JR from Posted Sheet Column A when B is empty
 * (text before first space or `|`).
 */
export function extractExecutivePostedJobRequisitionId(
  columnA: unknown
): string {
  const trimmed = String(columnA ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
  if (!trimmed) return "";
  const separatorIndex = trimmed.search(/[ |]/);
  if (separatorIndex < 0) return trimmed;
  return trimmed.slice(0, separatorIndex).trim();
}

export function buildExecutivePostedJrSet(
  rows: Array<{ jobRequisitionId?: string; postingText?: string }>
): Set<string> {
  const set = new Set<string>();
  for (const row of rows) {
    const fromB = String(row.jobRequisitionId ?? "")
      .replace(/\u00a0/g, " ")
      .trim();
    const id =
      fromB || extractExecutivePostedJobRequisitionId(row.postingText ?? "");
    if (id) set.add(id);
  }
  return set;
}

export function resolveExecutivePostedValue(
  jobRequisitionId: string,
  postedJrSet: Set<string>
): ExecutivePostedValue {
  const id = String(jobRequisitionId ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
  if (!id) return "-";
  return postedJrSet.has(id) ? "Yes" : "-";
}
