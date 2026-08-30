import { Router } from "express";
import { passwordMatches } from "../auth/passwords.js";
import {
  buildExpiredSessionCookie,
  buildSessionCookie,
  createSessionToken,
  getDashboardPassword,
  isAuthConfigured,
  resolveRole,
} from "../auth/session.js";
import {
  createUser,
  findUserByUsername,
  verifyUserPassword,
} from "../auth/users-store.js";
import { requireAccess } from "../middleware/auth.js";

const NO_STORE = { "Cache-Control": "no-store" };

export function createAuthRouter(): Router {
  const router = Router();

  router.get("/api/auth/login", (_req, res) => {
    res.status(200).set(NO_STORE).json({
      configured: isAuthConfigured(),
      allowlistEnabled: Boolean(process.env.ARA_OPERATOR_ALLOWLIST?.trim()),
    });
  });

  router.post("/api/auth/login", async (req, res) => {
    if (!isAuthConfigured()) {
      res.status(503).set(NO_STORE).json({
        error:
          "Authentication is not configured. Set ARA_SESSION_SECRET and ARA_DASHBOARD_PASSWORD.",
        code: "AUTH_NOT_CONFIGURED",
      });
      return;
    }

    const body = (req.body ?? {}) as {
      username?: string;
      password?: string;
    };
    const username = (body.username?.trim() || "operator").slice(0, 80);
    const password = body.password ?? "";

    const registered = await findUserByUsername(username);
    const matchedUser = registered
      ? await verifyUserPassword(username, password)
      : null;
    const sharedOk =
      !registered && passwordMatches(password, getDashboardPassword());

    if (!matchedUser && !sharedOk) {
      res.status(401).set(NO_STORE).json({
        error: "Invalid username or password.",
        code: "INVALID_CREDENTIALS",
      });
      return;
    }

    const sessionUsername = matchedUser?.username ?? username;
    const role = resolveRole(sessionUsername);
    const token = await createSessionToken({
      username: sessionUsername,
      role,
    });
    res
      .status(200)
      .set(NO_STORE)
      .set("Set-Cookie", buildSessionCookie(token))
      .json({ ok: true, username: sessionUsername, role });
  });

  router.post("/api/auth/signup", async (req, res) => {
    if (!isAuthConfigured()) {
      res.status(503).set(NO_STORE).json({
        error:
          "Authentication is not configured. Set ARA_SESSION_SECRET and ARA_DASHBOARD_PASSWORD.",
        code: "AUTH_NOT_CONFIGURED",
      });
      return;
    }

    const body = (req.body ?? {}) as {
      username?: string;
      password?: string;
    };

    try {
      const user = await createUser({
        username: body.username ?? "",
        password: body.password ?? "",
      });
      const role = resolveRole(user.username);
      const token = await createSessionToken({
        username: user.username,
        role,
      });
      res
        .status(201)
        .set(NO_STORE)
        .set("Set-Cookie", buildSessionCookie(token))
        .json({ ok: true, username: user.username, role });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not create account.";
      const code =
        error instanceof Error
          ? (error as Error & { code?: string }).code
          : undefined;
      const status = code === "USER_EXISTS" ? 409 : 400;
      res.status(status).set(NO_STORE).json({
        error: message,
        code: code ?? "SIGNUP_FAILED",
      });
    }
  });

  router.post(
    "/api/auth/logout",
    requireAccess("authenticated"),
    (_req, res) => {
      res
        .status(200)
        .set(NO_STORE)
        .set("Set-Cookie", buildExpiredSessionCookie())
        .json({ ok: true });
    }
  );

  router.get("/api/auth/me", requireAccess("authenticated"), (req, res) => {
    const session = req.auth!;
    res.status(200).set(NO_STORE).json({
      username: session.username,
      role: session.role,
      exp: session.exp,
    });
  });

  return router;
}
