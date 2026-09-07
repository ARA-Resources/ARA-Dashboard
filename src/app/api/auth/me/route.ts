import { NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/dal";
import { readOwnProfile } from "@/lib/auth/users-admin-db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  // verifySession re-reads role + active from Postgres (10s cache), so the
  // client always sees the user's CURRENT role, not the login-time token role.
  const user = await verifySession(request);
  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized", code: "UNAUTHENTICATED" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
  // Phase 4: also surface profile fields so the navbar can render the avatar.
  const profile = await readOwnProfile(user.id).catch(() => ({
    displayName: null,
    avatarColor: null,
  }));
  return NextResponse.json(
    {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      displayName: profile.displayName,
      avatarColor: profile.avatarColor,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
