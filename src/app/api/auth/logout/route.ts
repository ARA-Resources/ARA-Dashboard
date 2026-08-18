import { NextResponse } from "next/server";
import { buildExpiredSessionCookie } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST() {
  const response = NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } }
  );
  response.headers.set("Set-Cookie", buildExpiredSessionCookie());
  return response;
}
