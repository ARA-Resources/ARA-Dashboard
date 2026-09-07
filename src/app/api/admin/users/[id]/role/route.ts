/**
 * PATCH /api/admin/users/:id/role — change a user's role (super_admin only)
 *
 * Phase 4. Same gate as every /api/admin/* route (authorizeRequest → super_admin).
 * Body: { "role": "editor" | "admin" | "super_admin" }  — "viewer" is rejected
 * (signup-only, matches the invite rule). A super_admin cannot change their own
 * role (guard in updateUserRole).
 */
import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/dal";
import { updateUserRole, type AdminError } from "@/lib/auth/users-admin-db";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;

  const { id } = await context.params;

  let body: { role?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  try {
    const user = await updateUserRole({
      targetUserId: id,
      actingUserId: gate.user.id,
      role: (body.role ?? "").trim(),
    });
    return NextResponse.json({ ok: true, user }, { headers: NO_STORE });
  } catch (error) {
    const e = error as Partial<AdminError>;
    const status = typeof e.status === "number" ? e.status : 400;
    return NextResponse.json(
      { ok: false, error: e.message ?? "Could not update role.", code: e.code ?? "ROLE_UPDATE_FAILED" },
      { status, headers: NO_STORE }
    );
  }
}
