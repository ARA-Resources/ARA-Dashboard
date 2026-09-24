/**
 * Small pure field-transform utilities for ingesting an Oorwin sheet row
 * into the Candidate Master Sheet's Name / Contact Number fields.
 */

/**
 * Combines Oorwin's First/Middle/Last Name columns into one Name field.
 * Real sample data uses the literal "-" for an absent Middle Name (not a
 * blank cell) — treated as empty here, same as any blank/whitespace-only part.
 */
export function combineCandidateName(
  firstName: string,
  middleName: string,
  lastName: string
): string {
  return [firstName, middleName, lastName]
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "-")
    .join(" ");
}

export interface CandidateMobileNormalizeResult {
  ok: boolean;
  normalized: string | null;
}

/**
 * Strict 10-digit normalize: strips all non-digit characters, strips a
 * leading "91" country-code prefix if present (confirmed in real Oorwin
 * data, e.g. a Mobile cell holding 918797271671), and requires exactly 10
 * digits left. Anything that doesn't cleanly reduce to 10 digits is
 * reported as not-ok rather than guessed at — same rule already applied
 * and verified against the legacy migration's real data.
 */
export function normalizeCandidateMobile(raw: string): CandidateMobileNormalizeResult {
  const digits = raw.replace(/\D/g, "");
  const withoutCountryCode =
    digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  if (withoutCountryCode.length === 10) {
    return { ok: true, normalized: withoutCountryCode };
  }
  return { ok: false, normalized: null };
}
