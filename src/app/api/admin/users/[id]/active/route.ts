/**
 * PATCH /api/admin/users/:id/active — activate / deactivate a user (super_admin only)
 *
 * Phase 4. Same gate as every /api/admin/* route (authorizeRequest → super_admin).
 * Body: { "active": boolean }
 * A super_admin CANNOT deactivate their own account (guard in setUserActive).
 * A deactivated user is rejected on their next request (Phase 2 active check +
 * cache invalidation here).
 */
import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/dal";
import { setUserActive, type AdminError } from "@/lib/auth/users-admin-db";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;

  const { id } = await context.params;

  let body: { active?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  if (typeof body.active !== "boolean") {
    return NextResponse.json(
      { ok: false, error: "Body must include a boolean `active`.", code: "BAD_REQUEST" },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const user = await setUserActive({
      targetUserId: id,
      actingUserId: gate.user.id,
      active: body.active,
    });
    return NextResponse.json({ ok: true, user }, { headers: NO_STORE });
  } catch (error) {
    const e = error as Partial<AdminError>;
    const status = typeof e.status === "number" ? e.status : 400;
    return NextResponse.json(
      {
        ok: false,
        error: e.message ?? "Could not update account status.",
        code: e.code ?? "ACTIVE_UPDATE_FAILED",
      },
      { status, headers: NO_STORE }
    );
  }
}
