import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isApiPath, requiredAccess } from "@/lib/auth/access";
import {
  isAuthConfigured,
  verifySessionToken,
  readSessionCookie,
} from "@/lib/auth/session";

function unauthorizedJson() {
  return NextResponse.json(
    { error: "Unauthorized", code: "UNAUTHENTICATED" },
    { status: 401, headers: { "Cache-Control": "no-store" } }
  );
}

function forbiddenJson() {
  return NextResponse.json(
    { error: "Forbidden", code: "INSUFFICIENT_PERMISSION" },
    { status: 403, headers: { "Cache-Control": "no-store" } }
  );
}

function authNotConfiguredJson() {
  return NextResponse.json(
    {
      error:
        "Authentication is not configured. Set ARA_SESSION_SECRET and ARA_DASHBOARD_PASSWORD.",
      code: "AUTH_NOT_CONFIGURED",
    },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const access = requiredAccess(pathname, request.method);

  if (access === "public") {
    return NextResponse.next();
  }

  const api = isApiPath(pathname);

  if (!isAuthConfigured()) {
    if (api) return authNotConfiguredJson();
    if (pathname === "/login") return NextResponse.next();
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(login);
  }

  const token = readSessionCookie(request.headers.get("cookie"));
  const session = await verifySessionToken(token);

  if (!session) {
    if (api) return unauthorizedJson();
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = `?next=${encodeURIComponent(pathname + request.nextUrl.search)}`;
    return NextResponse.redirect(login);
  }

  if (access === "operator" && session.role !== "operator") {
    if (api) return forbiddenJson();
    return NextResponse.redirect(new URL("/home", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|assets/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
