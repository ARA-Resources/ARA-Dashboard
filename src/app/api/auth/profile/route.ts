/**
 * POST /api/auth/profile — update your own profile (display name + avatar colour)
 *
 * Phase 4. Any authenticated user, own account only (access.ts → "viewer";
 * the handler only ever touches gate.user.id). No file upload — the avatar is
 * initials + a colour from a fixed palette (src/lib/auth/avatar.ts).
 *
 * Body (any subset): { "displayName": string | null, "avatarColor": string | null }
 */
import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/dal";
import { updateOwnProfile, type AdminError } from "@/lib/auth/users-admin-db";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;

  let body: { displayName?: string | null; avatarColor?: string | null } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  try {
    const profile = await updateOwnProfile({
      userId: gate.user.id,
      displayName: body.displayName,
      avatarColor: body.avatarColor,
    });
    return NextResponse.json({ ok: true, profile }, { headers: NO_STORE });
  } catch (error) {
    const e = error as Partial<AdminError>;
    const status = typeof e.status === "number" ? e.status : 400;
    return NextResponse.json(
      {
        ok: false,
        error: e.message ?? "Could not update profile.",
        code: e.code ?? "PROFILE_UPDATE_FAILED",
      },
      { status, headers: NO_STORE }
    );
  }
}
