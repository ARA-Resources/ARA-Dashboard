/**
 * Next.js 16 Proxy (formerly `middleware.ts`).
 *
 * Runs on the Node.js runtime by default in Next 16 — the `runtime` config
 * option is not allowed here.
 *
 * Responsibilities (Phase 2):
 *   1. Verify the session cookie signature + expiry.
 *   2. Re-read role + `active` from Postgres (10s cache) — a role change or
 *      deactivation takes effect within seconds, not at token expiry.
 *   3. Enforce the 4-role access matrix (src/lib/auth/access.ts) on every
 *      route (pages and /api/*).
 *   4. `/api/cron/lateral` also accepts a valid `Authorization: Bearer
 *      <CRON_SECRET>` in place of a session.
 *
 * Route Handlers additionally call the DAL (src/lib/auth/dal.ts) close to the
 * data — proxy is the first gate, not the only one.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { isApiPath, requiredAccess } from "@/lib/auth/access";
import { roleMeets } from "@/lib/auth/roles";
import {
  buildExpiredSessionCookie,
  isAuthConfigured,
  readSessionCookie,
  verifySessionToken,
} from "@/lib/auth/session";
import { tokenPredatesPasswordChange } from "@/lib/auth/session-freshness";
import { getLiveAuthState } from "@/lib/auth/users-db";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function redirectToLogin(request: NextRequest, extraQuery?: Record<string, string>) {
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  login.searchParams.set(
    "next",
    request.nextUrl.pathname + request.nextUrl.search
  );
  for (const [k, v] of Object.entries(extraQuery ?? {})) {
    login.searchParams.set(k, v);
  }
  return NextResponse.redirect(login);
}

function cronSecretMatches(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (!token) return false;
  const a = Buffer.from(secret, "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method;
  const api = isApiPath(pathname);
  const required = requiredAccess(pathname, method);

  if (required === "public") {
    return NextResponse.next();
  }

  // Cron endpoint: a valid shared secret substitutes for a session.
  if (pathname === "/api/cron/lateral" && cronSecretMatches(request)) {
    return NextResponse.next();
  }

  if (!isAuthConfigured()) {
    if (api) {
      return json(503, {
        error:
          "Authentication is not configured. Set ARA_SESSION_SECRET and ARA_DASHBOARD_PASSWORD.",
        code: "AUTH_NOT_CONFIGURED",
      });
    }
    if (pathname === "/login") return NextResponse.next();
    return redirectToLogin(request);
  }

  const token = readSessionCookie(request.headers.get("cookie"));
  const session = await verifySessionToken(token);
  if (!session) {
    if (api) return json(401, { error: "Unauthorized", code: "UNAUTHENTICATED" });
    return redirectToLogin(request);
  }

  // Authoritative: current role + active from Postgres (10s cache).
  let state: Awaited<ReturnType<typeof getLiveAuthState>>;
  try {
    state = await getLiveAuthState(session.uid);
  } catch (error) {
    console.error("[proxy] auth state lookup failed", error);
    // Fail closed — cannot confirm the user, so deny.
    if (api) {
      return json(503, { error: "Authorization unavailable", code: "AUTHZ_UNAVAILABLE" });
    }
    return redirectToLogin(request);
  }

  if (!state) {
    // User row is gone (deleted). Treat as logged out.
    const res = api
      ? json(401, { error: "Unauthorized", code: "UNAUTHENTICATED" })
      : redirectToLogin(request);
    res.headers.append("Set-Cookie", buildExpiredSessionCookie());
    return res;
  }

  // Phase 4: a password change invalidates every session minted before it.
  if (tokenPredatesPasswordChange(session.exp, state.passwordChangedAt)) {
    const res = api
      ? json(401, { error: "Unauthorized", code: "UNAUTHENTICATED" })
      : redirectToLogin(request, { reauth: "1" });
    res.headers.append("Set-Cookie", buildExpiredSessionCookie());
    return res;
  }

  if (!state.active) {
    const res = api
      ? json(403, { error: "This account is deactivated.", code: "ACCOUNT_DEACTIVATED" })
      : redirectToLogin(request, { deactivated: "1" });
    res.headers.append("Set-Cookie", buildExpiredSessionCookie());
    return res;
  }

  if (!roleMeets(state.role, required)) {
    if (api) {
      return json(403, {
        error: "Forbidden",
        code: "INSUFFICIENT_ROLE",
        required,
      });
    }
    // Pages: bounce to Home (always allowed for any authenticated user).
    return NextResponse.redirect(new URL("/home", request.url));
  }

  // Pass identity downstream (handlers may read these instead of re-verifying).
  const headers = new Headers(request.headers);
  headers.set("x-ara-user-id", state.id);
  headers.set("x-ara-user-role", state.role);
  headers.set("x-ara-user-email", state.email);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|assets/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
