/**
 * GET /api/admin/users — list all users (super_admin only)
 *
 * Phase 4. Gated with the SAME pattern as the Phase 3 invite endpoints:
 * `authorizeRequest(request)` → `requiredAccess()` maps `/api/admin/users` to
 * "super_admin" (SUPER_ADMIN_API_PREFIXES in src/lib/auth/access.ts).
 * proxy.ts enforces the same minimum first. No bespoke check.
 */
import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/dal";
import { listAllUsers } from "@/lib/auth/users-admin-db";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;

  const users = await listAllUsers();
  return NextResponse.json(
    {
      ok: true,
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        active: u.active,
        displayName: u.displayName,
        avatarColor: u.avatarColor,
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
        isSelf: u.id === gate.user.id,
      })),
    },
    { headers: NO_STORE }
  );
}
