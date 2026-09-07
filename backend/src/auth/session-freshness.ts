/**
 * Session-freshness check (Phase 4). Mirror of src/lib/auth/session-freshness.ts.
 * Pure. Imported by backend/src/middleware/auth.ts.
 */
import { SESSION_TTL_SECONDS } from "./session.js";

export function tokenPredatesPasswordChange(
  sessionExp: number,
  passwordChangedAt: string | Date | null
): boolean {
  if (!passwordChangedAt) return false;
  const issuedAtSec = sessionExp - SESSION_TTL_SECONDS;
  const changedAtSec = Math.floor(new Date(passwordChangedAt).getTime() / 1000);
  return issuedAtSec < changedAtSec;
}
