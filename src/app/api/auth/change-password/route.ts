/**
 * POST /api/auth/change-password — change your own password
 *
 * Phase 4. Any authenticated user, own account only (access.ts → "viewer";
 * the handler only ever touches gate.user.id). Verifies the current password
 * server-side, re-hashes with scrypt, stamps password_changed_at.
 *
 * Every OTHER active session for this user is invalidated on its next request
 * (proxy.ts / DAL reject tokens minted before password_changed_at). The caller
 * stays signed in — we hand back a freshly minted cookie.
 */
import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/dal";
import { buildSessionCookie, createSessionToken } from "@/lib/auth/session";
import { validatePassword } from "@/lib/auth/users-store";
import { changeOwnPassword, type AdminError } from "@/lib/auth/users-admin-db";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;

  let body: {
    currentPassword?: string;
    newPassword?: string;
    confirmPassword?: string;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const currentPassword = body.currentPassword ?? "";
  const newPassword = body.newPassword ?? "";

  if (!currentPassword) {
    return NextResponse.json(
      { ok: false, error: "Enter your current password.", code: "VALIDATION" },
      { status: 400, headers: NO_STORE }
    );
  }
  const newError = validatePassword(newPassword);
  if (newError) {
    return NextResponse.json(
      { ok: false, error: newError, code: "VALIDATION" },
      { status: 400, headers: NO_STORE }
    );
  }
  if (body.confirmPassword !== undefined && body.confirmPassword !== newPassword) {
    return NextResponse.json(
      { ok: false, error: "New passwords do not match.", code: "VALIDATION" },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    await changeOwnPassword({
      userId: gate.user.id,
      currentPassword,
      newPassword,
    });
  } catch (error) {
    const e = error as Partial<AdminError>;
    const status = typeof e.status === "number" ? e.status : 400;
    return NextResponse.json(
      {
        ok: false,
        error: e.message ?? "Could not change password.",
        code: e.code ?? "PASSWORD_CHANGE_FAILED",
      },
      { status, headers: NO_STORE }
    );
  }

  // Keep the caller signed in with a fresh token (issued after the change).
  const token = await createSessionToken({
    uid: gate.user.id,
    username: gate.user.username || gate.user.email,
    role: gate.user.role,
  });
  const response = NextResponse.json(
    { ok: true, message: "Password changed. Other devices have been signed out." },
    { headers: NO_STORE }
  );
  response.headers.set("Set-Cookie", buildSessionCookie(token));
  return response;
}
