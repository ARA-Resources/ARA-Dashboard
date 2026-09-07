import { NextResponse } from "next/server";
import {
  buildSessionCookie,
  createSessionToken,
  isAuthConfigured,
} from "@/lib/auth/session";
import { recordLogin, verifyLoginCredentials } from "@/lib/auth/users-db";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(
    { configured: isAuthConfigured() },
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

  const email = (body.username?.trim() || "").slice(0, 200).toLowerCase();
  const password = body.password ?? "";

  // Phase 2: authenticate ONLY against the Postgres `users` table.
  // The shared ARA_DASHBOARD_PASSWORD login path has been removed.
  const user = email ? await verifyLoginCredentials(email, password) : null;

  if (!user) {
    return NextResponse.json(
      { error: "Invalid email or password.", code: "INVALID_CREDENTIALS" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  await recordLogin(user.id).catch((err) => {
    console.warn("[auth/login] failed to record last_login_at", err);
  });

  const token = await createSessionToken({
    uid: user.id,
    username: user.email,
    role: user.role,
  });
  const response = NextResponse.json(
    { ok: true, username: user.email, role: user.role },
    { headers: { "Cache-Control": "no-store" } }
  );
  response.headers.set("Set-Cookie", buildSessionCookie(token));
  return response;
}
