/**
 * Executive Posted Sheet -> executive_master.posted rule (Phase E6).
 *
 * CORRECTED rule — deliberately NOT Lateral's "presence on the list = Yes"
 * rule (`executive-posted-rules.ts`, which this module supersedes for the
 * live pipeline; that file is left untouched, superseded not deleted, per
 * the project's E7-cleanup boundary). Confirmed source shape: column A raw
 * text, column B clean Job Requisition ID, column C literal "Yes"/"No"
 * "Demand" text present on every row.
 *
 * Rule: for each JR in executive_master, look up by the sheet's JR column.
 *   found AND Demand="Yes" -> "Yes"
 *   found AND Demand="No"  -> "-"
 *   not found at all       -> "-"
 * Never converts "-" back to "No" — "-" is the terminal absent/negative state.
 */

export type ExecutivePostedDemandValue = "Yes" | "No";
export type ExecutivePostedValue = "Yes" | "-";

export function normalizeExecutivePostedJobRequisitionId(
  value: unknown
): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\u00a0/g, " ")
    .trim();
}

/**
 * Normalize the literal "Demand" cell text. Only exact "Yes"/"No" (any
 * casing, trimmed) are recognized — anything else (blank, unexpected text)
 * is treated as unrecognized and excluded from the lookup map entirely, so
 * a malformed row can never silently grant "Yes".
 */
export function normalizeExecutivePostedDemandValue(
  value: unknown
): ExecutivePostedDemandValue | null {
  const text = String(value ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .toLowerCase();
  if (text === "yes") return "Yes";
  if (text === "no") return "No";
  return null;
}

/**
 * Build the JR -> Demand lookup from parsed Posted Sheet rows.
 * Duplicate JRs (not expected, but not prohibited by the spec either): "Yes"
 * wins over "No" for the same JR, so one confirmed-posted row can never be
 * silently overridden by a stray duplicate — an explicit, stated default in
 * the absence of a specified duplicate-handling rule.
 */
export function buildExecutivePostedDemandMap(
  rows: Array<{ jobRequisitionId: unknown; demand: unknown }>
): Map<string, ExecutivePostedDemandValue> {
  const map = new Map<string, ExecutivePostedDemandValue>();
  for (const row of rows) {
    const jr = normalizeExecutivePostedJobRequisitionId(row.jobRequisitionId);
    if (!jr) continue;
    const demand = normalizeExecutivePostedDemandValue(row.demand);
    if (!demand) continue;
    const existing = map.get(jr);
    if (existing === "Yes") continue; // Yes is sticky
    map.set(jr, demand);
  }
  return map;
}

/**
 * Resolve one JR's Posted value per the confirmed rule.
 */
export function resolveExecutivePostedFromDemandMap(
  jobRequisitionId: string,
  demandMap: Map<string, ExecutivePostedDemandValue>
): ExecutivePostedValue {
  const jr = normalizeExecutivePostedJobRequisitionId(jobRequisitionId);
  if (!jr) return "-";
  return demandMap.get(jr) === "Yes" ? "Yes" : "-";
}
