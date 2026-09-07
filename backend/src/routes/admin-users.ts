/**
 * /api/admin/users — super_admin only (Phase 4).
 * Mirror of src/app/api/admin/users/**. Gated with requireAccess("super_admin"),
 * the same pattern as every other admin route.
 */
import { Router } from "express";
import type { Response } from "express";
import "../types/express-auth.js";
import { requireAccess } from "../middleware/auth.js";
import {
  changeOwnPassword,
  listAllUsers,
  setUserActive,
  updateUserRole,
  updateOwnProfile,
  type AdminError,
} from "../auth/users-admin-db.js";
import {
  buildSessionCookie,
  createSessionToken,
} from "../auth/session.js";
import { validatePassword } from "../auth/users-store.js";

const NO_STORE = { "Cache-Control": "no-store" };

function fail(res: Response, error: unknown, dflt: string) {
  const e = error as Partial<AdminError>;
  const status = typeof e.status === "number" ? e.status : 400;
  res.status(status).set(NO_STORE).json({
    ok: false,
    error: e.message ?? dflt,
    code: e.code ?? "ADMIN_ACTION_FAILED",
  });
}

export function createAdminUsersRouter(): Router {
  const router = Router();

  router.get("/api/admin/users", requireAccess("super_admin"), async (req, res) => {
    const users = await listAllUsers();
    res.status(200).set(NO_STORE).json({
      ok: true,
      users: users.map((u) => ({ ...u, isSelf: u.id === req.auth?.uid })),
    });
  });

  router.patch(
    "/api/admin/users/:id/role",
    requireAccess("super_admin"),
    async (req, res) => {
      const body = (req.body ?? {}) as { role?: string };
      try {
        const user = await updateUserRole({
          targetUserId: String(req.params.id),
          actingUserId: req.auth?.uid ?? "",
          role: (body.role ?? "").trim(),
        });
        res.status(200).set(NO_STORE).json({ ok: true, user });
      } catch (error) {
        fail(res, error, "Could not update role.");
      }
    }
  );

  router.patch(
    "/api/admin/users/:id/active",
    requireAccess("super_admin"),
    async (req, res) => {
      const body = (req.body ?? {}) as { active?: unknown };
      if (typeof body.active !== "boolean") {
        res.status(400).set(NO_STORE).json({
          ok: false,
          error: "Body must include a boolean `active`.",
          code: "BAD_REQUEST",
        });
        return;
      }
      try {
        const user = await setUserActive({
          targetUserId: String(req.params.id),
          actingUserId: req.auth?.uid ?? "",
          active: body.active,
        });
        res.status(200).set(NO_STORE).json({ ok: true, user });
      } catch (error) {
        fail(res, error, "Could not update account status.");
      }
    }
  );

  return router;
}

/** Self-service account routes — mounted alongside the auth router. */
export function createAccountRouter(): Router {
  const router = Router();

  router.post(
    "/api/auth/change-password",
    requireAccess("authenticated"),
    async (req, res) => {
      const body = (req.body ?? {}) as {
        currentPassword?: string;
        newPassword?: string;
        confirmPassword?: string;
      };
      const currentPassword = body.currentPassword ?? "";
      const newPassword = body.newPassword ?? "";

      if (!currentPassword) {
        res.status(400).set(NO_STORE).json({
          ok: false,
          error: "Enter your current password.",
          code: "VALIDATION",
        });
        return;
      }
      const newError = validatePassword(newPassword);
      if (newError) {
        res
          .status(400)
          .set(NO_STORE)
          .json({ ok: false, error: newError, code: "VALIDATION" });
        return;
      }
      if (
        body.confirmPassword !== undefined &&
        body.confirmPassword !== newPassword
      ) {
        res.status(400).set(NO_STORE).json({
          ok: false,
          error: "New passwords do not match.",
          code: "VALIDATION",
        });
        return;
      }

      try {
        await changeOwnPassword({
          userId: req.auth?.uid ?? "",
          currentPassword,
          newPassword,
        });
      } catch (error) {
        fail(res, error, "Could not change password.");
        return;
      }

      const token = await createSessionToken({
        uid: req.auth?.uid ?? "",
        username: req.auth?.username ?? "",
        role: req.auth?.role ?? "viewer",
      });
      res
        .status(200)
        .set(NO_STORE)
        .set("Set-Cookie", buildSessionCookie(token))
        .json({
          ok: true,
          message: "Password changed. Other devices have been signed out.",
        });
    }
  );

  router.post(
    "/api/auth/profile",
    requireAccess("authenticated"),
    async (req, res) => {
      const body = (req.body ?? {}) as {
        displayName?: string | null;
        avatarColor?: string | null;
      };
      try {
        const profile = await updateOwnProfile({
          userId: req.auth?.uid ?? "",
          displayName: body.displayName,
          avatarColor: body.avatarColor,
        });
        res.status(200).set(NO_STORE).json({ ok: true, profile });
      } catch (error) {
        fail(res, error, "Could not update profile.");
      }
    }
  );

  return router;
}
