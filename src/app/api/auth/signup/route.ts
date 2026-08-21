import { NextResponse } from "next/server";
import {
  buildSessionCookie,
  createSessionToken,
  isAuthConfigured,
  resolveRole,
} from "@/lib/auth/session";
import { createUser } from "@/lib/auth/users-store";

export const runtime = "nodejs";

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

  let body: { username?: string; password?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  try {
    const user = await createUser({
      username: body.username ?? "",
      password: body.password ?? "",
    });
    const role = resolveRole(user.username);
    const token = await createSessionToken({
      username: user.username,
      role,
    });
    const response = NextResponse.json(
      { ok: true, username: user.username, role },
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
