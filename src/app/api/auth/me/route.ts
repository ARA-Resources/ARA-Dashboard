import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized", code: "UNAUTHENTICATED" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.json(
    {
      username: session.username,
      role: session.role,
      exp: session.exp,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
