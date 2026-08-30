import { NextResponse } from "next/server";
import { passwordMatches } from "@/lib/auth/passwords";
import {
  buildSessionCookie,
  createSessionToken,
  getDashboardPassword,
  isAuthConfigured,
  resolveRole,
} from "@/lib/auth/session";
import { findUserByUsername, verifyUserPassword } from "@/lib/auth/users-store";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(
    {
      configured: isAuthConfigured(),
      allowlistEnabled: Boolean(
        process.env.ARA_OPERATOR_ALLOWLIST?.trim()
      ),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

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

  const username = (body.username?.trim() || "operator").slice(0, 80);
  const password = body.password ?? "";

  const registered = await findUserByUsername(username);
  const matchedUser = registered
    ? await verifyUserPassword(username, password)
    : null;
  const sharedOk =
    !registered && passwordMatches(password, getDashboardPassword());

  if (!matchedUser && !sharedOk) {
    return NextResponse.json(
      { error: "Invalid username or password.", code: "INVALID_CREDENTIALS" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const sessionUsername = matchedUser?.username ?? username;
  const role = resolveRole(sessionUsername);
  const token = await createSessionToken({ username: sessionUsername, role });
  const response = NextResponse.json(
    { ok: true, username: sessionUsername, role },
    { headers: { "Cache-Control": "no-store" } }
  );
  response.headers.set("Set-Cookie", buildSessionCookie(token));
  return response;
}
