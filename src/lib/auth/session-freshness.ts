/**
 * Session-freshness check (Phase 4).
 *
 * The session cookie is a stateless HMAC token with a fixed 12h TTL, so
 * `issuedAt = exp - SESSION_TTL_SECONDS`. When a user changes their password we
 * stamp `users.password_changed_at`; every authoritative auth check
 * (proxy.ts + the DAL) then rejects any token issued before that moment. The
 * changer's own session survives because the change-password endpoint hands
 * them a freshly minted cookie.
 *
 * Pure — no DB, no crypto. Imported by proxy.ts and src/lib/auth/dal.ts.
 */
import { SESSION_TTL_SECONDS } from "@/lib/auth/session";

/**
 * True when `sessionExp` (unix seconds, from the token) belongs to a token that
 * was minted before `passwordChangedAt`. `null` passwordChangedAt → never true.
 */
export function tokenPredatesPasswordChange(
  sessionExp: number,
  passwordChangedAt: string | Date | null
): boolean {
  if (!passwordChangedAt) return false;
  // Token issued-at, whole seconds (exp is floor(now/1000) + TTL at mint time).
  const issuedAtSec = sessionExp - SESSION_TTL_SECONDS;
  // Compare against the whole second of the change. The change-password
  // endpoint stamps password_changed_at, THEN mints the caller a new token in
  // the same (or a later) second, so its issuedAtSec is >= changedAtSec and it
  // survives; every token from an earlier second is rejected. The only gap is a
  // login in the very same second as the change but before it — negligible, and
  // that session used the now-invalid old password anyway.
  const changedAtSec = Math.floor(new Date(passwordChangedAt).getTime() / 1000);
  return issuedAtSec < changedAtSec;
}
