/**
 * GET  /api/auth/accept-invite?token=…  — validate a token, return {email, role}
 * POST /api/auth/accept-invite          — set a password, create the account
 *
 * Phase 3. PUBLIC (the invited person is not signed in yet) — see
 * src/lib/auth/access.ts. The role is ALWAYS taken from the invite row, never
 * from the request body.
 *
 * On success the new account is signed in (session cookie set), same as signup.
 */
import { NextResponse } from "next/server";
import {
  buildSessionCookie,
  createSessionToken,
  isAuthConfigured,
} from "@/lib/auth/session";
import { validatePassword } from "@/lib/auth/users-store";
import {
  acceptInvite,
  findPendingInvite,
  type InviteError,
} from "@/lib/auth/invites-db";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";

  let result;
  try {
    result = await findPendingInvite(token);
  } catch (error) {
    console.error("[accept-invite] lookup failed", error);
    return NextResponse.json(
      {
        ok: false,
        error: "Could not check this invite right now. Try again shortly.",
        code: "INVITE_CHECK_FAILED",
      },
      { status: 503, headers: NO_STORE }
    );
  }

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.message, code: result.code },
      { status: result.status, headers: NO_STORE }
    );
  }

  return NextResponse.json(
    { ok: true, email: result.email, role: result.role },
    { headers: NO_STORE }
  );
}

export async function POST(request: Request) {
  if (!isAuthConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: "Authentication is not configured.",
        code: "AUTH_NOT_CONFIGURED",
      },
      { status: 503, headers: NO_STORE }
    );
  }

  let body: { token?: string; password?: string; confirmPassword?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const token = (body.token ?? "").trim();
  const password = body.password ?? "";

  if (!token) {
    return NextResponse.json(
      { ok: false, error: "This invite link is missing its token.", code: "INVITE_INVALID" },
      { status: 400, headers: NO_STORE }
    );
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    return NextResponse.json(
      { ok: false, error: passwordError, code: "VALIDATION" },
      { status: 400, headers: NO_STORE }
    );
  }
  if (
    body.confirmPassword !== undefined &&
    body.confirmPassword !== password
  ) {
    return NextResponse.json(
      { ok: false, error: "Passwords do not match.", code: "VALIDATION" },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const { user } = await acceptInvite({ token, password });
    const sessionToken = await createSessionToken({
      uid: user.id,
      username: user.email,
      role: user.role,
    });
    const response = NextResponse.json(
      { ok: true, username: user.email, role: user.role },
      { status: 201, headers: NO_STORE }
    );
    response.headers.set("Set-Cookie", buildSessionCookie(sessionToken));
    return response;
  } catch (error) {
    const e = error as Partial<InviteError>;
    const status = typeof e.status === "number" ? e.status : 400;
    return NextResponse.json(
      {
        ok: false,
        error: e.message ?? "Could not complete the invite.",
        code: e.code ?? "INVITE_FAILED",
      },
      { status, headers: NO_STORE }
    );
  }
}
