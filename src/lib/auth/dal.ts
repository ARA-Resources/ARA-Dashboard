/**
 * Data Access Layer — authoritative authorization (Phase 2).
 *
 * Next.js 16 guidance: `proxy.ts` does only OPTIMISTIC checks (cookie-only);
 * the real check happens close to the data. This module is that check. Route
 * Handlers call `authorizeRequest(request)` (or `requireRole`) before doing any
 * work; Server Components can call `verifySession()`.
 *
 * Every call re-reads role + `active` from Postgres (via a ~10s cache), so a
 * role change or deactivation takes effect within seconds regardless of the
 * token minted at login.
 *
 * Node.js runtime only.
 */
import { requiredAccess, type AccessLevel } from "@/lib/auth/access";
import { roleMeets, type Role } from "@/lib/auth/roles";
import {
  isAuthConfigured,
  readSessionCookie,
  verifySessionToken,
} from "@/lib/auth/session";
import { tokenPredatesPasswordChange } from "@/lib/auth/session-freshness";
import { getLiveAuthState } from "@/lib/auth/users-db";

export type AuthedUser = {
  id: string;
  username: string;
  email: string;
  role: Role;
};

export type AuthorizeFailure =
  | { reason: "auth_not_configured"; status: 503 }
  | { reason: "unauthenticated"; status: 401 }
  | { reason: "deactivated"; status: 403 }
  | { reason: "insufficient_role"; status: 403; required: Role };

export type AuthorizeResult =
  | { ok: true; user: AuthedUser }
  | { ok: false; failure: AuthorizeFailure; response: Response };

const NO_STORE = { "Cache-Control": "no-store" } as const;

function fail(failure: AuthorizeFailure): AuthorizeResult {
  const body =
    failure.reason === "auth_not_configured"
      ? { error: "Authentication is not configured.", code: "AUTH_NOT_CONFIGURED" }
      : failure.reason === "unauthenticated"
        ? { error: "Unauthorized", code: "UNAUTHENTICATED" }
        : failure.reason === "deactivated"
          ? { error: "This account is deactivated.", code: "ACCOUNT_DEACTIVATED" }
          : {
              error: "Forbidden",
              code: "INSUFFICIENT_ROLE",
              required: failure.required,
            };
  return {
    ok: false,
    failure,
    response: Response.json(body, { status: failure.status, headers: NO_STORE }),
  };
}

/**
 * Verify the caller's session and current DB state.
 * Returns null when unauthenticated / token invalid / user missing / inactive.
 */
export async function verifySession(request: Request): Promise<AuthedUser | null> {
  if (!isAuthConfigured()) return null;
  const token = readSessionCookie(request.headers.get("cookie"));
  const session = await verifySessionToken(token);
  if (!session) return null;
  const state = await getLiveAuthState(session.uid);
  if (!state || !state.active) return null;
  // Phase 4: a password change signs out every session minted before it.
  if (tokenPredatesPasswordChange(session.exp, state.passwordChangedAt)) {
    return null;
  }
  return {
    id: state.id,
    username: session.username,
    email: state.email,
    role: state.role, // DB is source of truth, not the token
  };
}

/**
 * Full gate for a Route Handler: derives the required role from the request's
 * path + method and enforces it against the DB role + `active`.
 *
 *   const gate = await authorizeRequest(request);
 *   if (!gate.ok) return gate.response;
 *   // gate.user is the authenticated, authorized user
 */
export async function authorizeRequest(
  request: Request,
  overrideRequired?: AccessLevel
): Promise<AuthorizeResult> {
  const url = new URL(request.url);
  const required =
    overrideRequired ?? requiredAccess(url.pathname, request.method);

  if (required === "public") {
    const user = await verifySession(request).catch(() => null);
    return user
      ? { ok: true, user }
      : {
          ok: true,
          user: { id: "", username: "", email: "", role: "viewer" },
        };
  }

  if (!isAuthConfigured()) return fail({ reason: "auth_not_configured", status: 503 });

  const token = readSessionCookie(request.headers.get("cookie"));
  const session = await verifySessionToken(token);
  if (!session) return fail({ reason: "unauthenticated", status: 401 });

  const state = await getLiveAuthState(session.uid);
  if (!state) return fail({ reason: "unauthenticated", status: 401 });
  if (!state.active) return fail({ reason: "deactivated", status: 403 });
  if (tokenPredatesPasswordChange(session.exp, state.passwordChangedAt)) {
    return fail({ reason: "unauthenticated", status: 401 });
  }

  if (!roleMeets(state.role, required)) {
    return fail({ reason: "insufficient_role", status: 403, required });
  }

  return {
    ok: true,
    user: {
      id: state.id,
      username: session.username,
      email: state.email,
      role: state.role,
    },
  };
}

/** Explicit minimum-role gate for a Route Handler. */
export async function requireRole(
  request: Request,
  minimum: Role
): Promise<AuthorizeResult> {
  return authorizeRequest(request, minimum);
}
