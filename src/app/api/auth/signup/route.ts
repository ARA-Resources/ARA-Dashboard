import { NextResponse } from "next/server";
import {
  buildSessionCookie,
  createSessionToken,
  isAuthConfigured,
} from "@/lib/auth/session";
import { createSignupUser } from "@/lib/auth/users-db";
import {
  isAllowedSignupEmail,
  validatePassword,
  validateUsername,
} from "@/lib/auth/users-store";

export const runtime = "nodejs";

/**
 * Public self-service signup.
 *
 * Writes to the Postgres `users` table. New accounts are ALWAYS role 'viewer'
 * (hard-coded in createSignupUser). Any `role` field in the request body is
 * rejected outright — elevated roles come only through the invite flow
 * (POST /api/admin/invites → /accept-invite).
 */
export async function POST(request: Request) {
  if (!isAuthConfigured()) {
    return NextResponse.json(
      {
        error:
          "Authentication is not configured. Set ARA_SESSION_SECRET and ARA_DASHBOARD_PASSWORD.",
        code: "AUTH_NOT_CONFIGURED",
      },
      { status: 503 }
    );
  }

  let body: {
    username?: string;
    password?: string;
    role?: unknown;
    roleId?: unknown;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  // Public signup can NEVER pick a role. Reject rather than silently ignore.
  if (body.role !== undefined || body.roleId !== undefined) {
    return NextResponse.json(
      {
        error:
          "Signup cannot set a role. New accounts are always 'viewer'. " +
          "Elevated roles are issued via invite.",
        code: "ROLE_NOT_ALLOWED",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const email = (body.username ?? "").trim().toLowerCase();
  const password = body.password ?? "";

  const usernameError = validateUsername(email);
  if (usernameError) {
    return NextResponse.json(
      { error: usernameError, code: "SIGNUP_FAILED" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (!isAllowedSignupEmail(email)) {
    return NextResponse.json(
      {
        error: "Sign-up is restricted to an @araresources.com email address.",
        code: "SIGNUP_FAILED",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
  const passwordError = validatePassword(password);
  if (passwordError) {
    return NextResponse.json(
      { error: passwordError, code: "SIGNUP_FAILED" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const user = await createSignupUser({ email, password });
    const token = await createSessionToken({
      uid: user.id,
      username: user.email,
      role: user.role,
    });
    const response = NextResponse.json(
      { ok: true, username: user.email, role: user.role },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
    response.headers.set("Set-Cookie", buildSessionCookie(token));
    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not create account.";
    const code =
      error instanceof Error
        ? (error as Error & { code?: string }).code
        : undefined;
    const status = code === "USER_EXISTS" ? 409 : 400;
    return NextResponse.json(
      { error: message, code: code ?? "SIGNUP_FAILED" },
      { status, headers: { "Cache-Control": "no-store" } }
    );
  }
}
