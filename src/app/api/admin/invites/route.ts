/**
 * POST /api/admin/invites  — create a single-use invite (super_admin only)
 * GET  /api/admin/invites  — list recent invites (super_admin only)
 *
 * Phase 3. Gated with the SAME pattern as every other Phase 2 route:
 * `authorizeRequest(request)` derives the required role from the path via
 * `requiredAccess()` — `/api/admin/invites` is pre-mapped to "super_admin" in
 * src/lib/auth/access.ts (SUPER_ADMIN_API_PREFIXES). No bespoke role check here.
 * `src/proxy.ts` enforces the same minimum before the handler even runs.
 *
 * No email is sent — the response carries a copy/paste accept link.
 */
import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/dal";
import { getAppUrl } from "@/lib/config/runtime";
import {
  createInvite,
  listRecentInvites,
  type InviteError,
} from "@/lib/auth/invites-db";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Absolute link the invited person opens in their own browser. Uses the same
 * public-URL source of truth as the Gmail OAuth redirect URI
 * (getAppUrl → ARA_APP_URL / NEXT_PUBLIC_APP_URL). getAppUrl() throws in
 * production if that is unset — an invite link must never fall back to an
 * internal origin like localhost:3000.
 */
function acceptUrl(token: string): string {
  return `${getAppUrl()}/accept-invite?token=${encodeURIComponent(token)}`;
}

export async function POST(request: Request) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;

  let body: { email?: string; role?: string; expiresInDays?: number } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  try {
    const invite = await createInvite({
      email: (body.email ?? "").trim(),
      role: (body.role ?? "").trim(),
      createdBy: gate.user.id || null,
      expiresInDays:
        typeof body.expiresInDays === "number" ? body.expiresInDays : undefined,
    });

    return NextResponse.json(
      {
        ok: true,
        invite: {
          email: invite.email,
          role: invite.role,
          token: invite.token,
          expiresAt: invite.expiresAt,
          acceptUrl: acceptUrl(invite.token),
        },
      },
      { status: 201, headers: NO_STORE }
    );
  } catch (error) {
    const e = error as Partial<InviteError>;
    const status = typeof e.status === "number" ? e.status : 400;
    return NextResponse.json(
      {
        ok: false,
        error: e.message ?? "Could not create the invite.",
        code: e.code ?? "INVITE_FAILED",
      },
      { status, headers: NO_STORE }
    );
  }
}

export async function GET(request: Request) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;

  const invites = await listRecentInvites();
  return NextResponse.json(
    {
      ok: true,
      invites: invites.map((invite) => ({
        email: invite.email,
        role: invite.role,
        status: invite.status,
        expiresAt: invite.expiresAt,
        usedAt: invite.usedAt,
        createdAt: invite.createdAt,
        acceptUrl: acceptUrl(invite.token),
      })),
    },
    { headers: NO_STORE }
  );
}
