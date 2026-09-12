/**
 * Executive Priority normalization.
 *
 * The source Executive Master Sheet stores Priority as a VLOOKUP against an
 * external workbook, so its casing is inconsistent:
 *   "Very high priority"                                  -> "Very High Priority"
 *   "High Priority"                                       -> "High Priority"
 *   "Do not add supply" / "Do not Add Supply" / ...casings -> "Do Not Add Supply"
 *   "" / null                                             -> null
 *
 * Applied at one-time import and (later) at pipeline time - same approach as
 * Lateral's code-level normalization. The `executive_master.priority` column is
 * free TEXT (no CHECK), so an unrecognised value is trimmed and kept verbatim
 * rather than dropped.
 */

export const EXECUTIVE_PRIORITY_CANONICAL_VALUES = [
  "Very High Priority",
  "High Priority",
  "Do Not Add Supply",
] as const;

export type ExecutivePriorityCanonicalValue =
  (typeof EXECUTIVE_PRIORITY_CANONICAL_VALUES)[number];

const NBSP = / /g;

export function normalizeExecutivePriority(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(NBSP, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  if (/^do not add supply$/.test(lower)) return "Do Not Add Supply";
  if (lower === "very high priority") return "Very High Priority";
  if (lower === "high priority") return "High Priority";

  // Unknown value - keep it verbatim (trimmed). priority is free TEXT.
  return text;
}
