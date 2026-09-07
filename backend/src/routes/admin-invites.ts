/**
 * GET/POST /api/admin/invites — super_admin only (Phase 3).
 * Mirror of src/app/api/admin/invites/route.ts.
 *
 * Gated with the SAME pattern as every other route: requireAccess("super_admin")
 * (which re-reads role + active from Postgres via the 10s cache).
 */
import { Router } from "express";
import "../types/express-auth.js";
import { requireAccess } from "../middleware/auth.js";
import { getAppUrl } from "../config/runtime.js";
import {
  createInvite,
  listRecentInvites,
  type InviteError,
} from "../auth/invites-db.js";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Absolute link the invited person opens in their own browser. Same public-URL
 * source of truth as the Gmail OAuth redirect URI
 * (getAppUrl → ARA_APP_URL / NEXT_PUBLIC_APP_URL) — never the request host,
 * which is an internal origin behind the reverse proxy.
 */
function acceptUrl(token: string): string {
  return `${getAppUrl()}/accept-invite?token=${encodeURIComponent(token)}`;
}

export function createAdminInvitesRouter(): Router {
  const router = Router();

  router.post(
    "/api/admin/invites",
    requireAccess("super_admin"),
    async (req, res) => {
      const body = (req.body ?? {}) as {
        email?: string;
        role?: string;
        expiresInDays?: number;
      };
      try {
        const invite = await createInvite({
          email: (body.email ?? "").trim(),
          role: (body.role ?? "").trim(),
          createdBy: req.auth?.uid ?? null,
          expiresInDays:
            typeof body.expiresInDays === "number"
              ? body.expiresInDays
              : undefined,
        });
        res.status(201).set(NO_STORE).json({
          ok: true,
          invite: {
            email: invite.email,
            role: invite.role,
            token: invite.token,
            expiresAt: invite.expiresAt,
            acceptUrl: acceptUrl(invite.token),
          },
        });
      } catch (error) {
        const e = error as Partial<InviteError>;
        const status = typeof e.status === "number" ? e.status : 400;
        res.status(status).set(NO_STORE).json({
          ok: false,
          error: e.message ?? "Could not create the invite.",
          code: e.code ?? "INVITE_FAILED",
        });
      }
    }
  );

  router.get(
    "/api/admin/invites",
    requireAccess("super_admin"),
    async (req, res) => {
      const invites = await listRecentInvites();
      res.status(200).set(NO_STORE).json({
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
      });
    }
  );

  return router;
}
