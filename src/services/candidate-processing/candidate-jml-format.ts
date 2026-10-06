/**
 * Shared Job Management Level number <-> text helpers for the Accenture
 * Final Report upload. The level is always COMPARED and STORED by its
 * number — "9-Team Lead/Consultant" (Accenture's own descriptive text,
 * also what lateral_master/executive_master store) and "CL9" (the
 * canonical form this engine writes) are the same level; a cell matching
 * either format reduces to the same number and is never treated as a
 * change if only the format differs.
 */

const DASH_PREFIX_REGEX = /^(\d+)-/;
const CL_PREFIX_REGEX = /^cl-?(\d+)$/i;

/** "9-Team Lead/Consultant" -> 9, "CL9" / "cl-9" -> 9, anything else -> null. */
export function extractJmlNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const dashMatch = trimmed.match(DASH_PREFIX_REGEX);
  if (dashMatch) return Number(dashMatch[1]);
  const clMatch = trimmed.match(CL_PREFIX_REGEX);
  if (clMatch) return Number(clMatch[1]);
  return null;
}

/** 9 -> "CL9" — the canonical form written/logged by the Accenture engine. */
export function formatJmlAsLegacy(n: number): string {
  return `CL${n}`;
}
