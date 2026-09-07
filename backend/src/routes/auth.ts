import { Router } from "express";
import {
  buildExpiredSessionCookie,
  buildSessionCookie,
  createSessionToken,
  isAuthConfigured,
} from "../auth/session.js";
import {
  createSignupUser,
  recordLogin,
  verifyLoginCredentials,
} from "../auth/users-db.js";
import {
  isAllowedSignupEmail,
  validatePassword,
  validateUsername,
} from "../auth/users-store.js";
import {
  acceptInvite,
  findPendingInvite,
  type InviteError,
} from "../auth/invites-db.js";
import { requireAccess } from "../middleware/auth.js";

const NO_STORE = { "Cache-Control": "no-store" };

export function createAuthRouter(): Router {
  const router = Router();

  router.get("/api/auth/login", (_req, res) => {
    res.status(200).set(NO_STORE).json({ configured: isAuthConfigured() });
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

    const body = (req.body ?? {}) as { username?: string; password?: string };
    const email = (body.username?.trim() || "").slice(0, 200).toLowerCase();
    const password = body.password ?? "";

    // Phase 2: Postgres `users` only. Shared-password login removed.
    const user = email
      ? await verifyLoginCredentials(email, password)
      : null;

    if (!user) {
      res.status(401).set(NO_STORE).json({
        error: "Invalid email or password.",
        code: "INVALID_CREDENTIALS",
      });
      return;
    }

    await recordLogin(user.id).catch(() => undefined);

    const token = await createSessionToken({
      uid: user.id,
      username: user.email,
      role: user.role,
    });
    res
      .status(200)
      .set(NO_STORE)
      .set("Set-Cookie", buildSessionCookie(token))
      .json({ ok: true, username: user.email, role: user.role });
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
      role?: unknown;
      roleId?: unknown;
    };

    // Public signup can NEVER pick a role. Reject rather than silently ignore.
    if (body.role !== undefined || body.roleId !== undefined) {
      res.status(400).set(NO_STORE).json({
        error:
          "Signup cannot set a role. New accounts are always 'viewer'. " +
          "Elevated roles are issued via invite.",
        code: "ROLE_NOT_ALLOWED",
      });
      return;
    }

    const email = (body.username ?? "").trim().toLowerCase();
    const password = body.password ?? "";

    const usernameError = validateUsername(email);
    if (usernameError) {
      res
        .status(400)
        .set(NO_STORE)
        .json({ error: usernameError, code: "SIGNUP_FAILED" });
      return;
    }
    if (!isAllowedSignupEmail(email)) {
      res.status(400).set(NO_STORE).json({
        error: "Sign-up is restricted to an @araresources.com email address.",
        code: "SIGNUP_FAILED",
      });
      return;
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      res
        .status(400)
        .set(NO_STORE)
        .json({ error: passwordError, code: "SIGNUP_FAILED" });
      return;
    }

    try {
      const user = await createSignupUser({ email, password });
      const token = await createSessionToken({
        uid: user.id,
        username: user.email,
        role: user.role,
      });
      res
        .status(201)
        .set(NO_STORE)
        .set("Set-Cookie", buildSessionCookie(token))
        .json({ ok: true, username: user.email, role: user.role });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not create account.";
      const code =
        error instanceof Error
          ? (error as Error & { code?: string }).code
          : undefined;
      const status = code === "USER_EXISTS" ? 409 : 400;
      res
        .status(status)
        .set(NO_STORE)
        .json({ error: message, code: code ?? "SIGNUP_FAILED" });
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
      uid: session.uid,
      username: session.username,
      role: session.role,
      exp: session.exp,
    });
  });

  // ---- Phase 3: invite acceptance (PUBLIC — the invited person has no session) ----

  router.get("/api/auth/accept-invite", async (req, res) => {
    const token = String((req.query?.token as string) ?? "");
    let result;
    try {
      result = await findPendingInvite(token);
    } catch {
      res.status(503).set(NO_STORE).json({
        ok: false,
        error: "Could not check this invite right now. Try again shortly.",
        code: "INVITE_CHECK_FAILED",
      });
      return;
    }
    if (!result.ok) {
      res
        .status(result.status)
        .set(NO_STORE)
        .json({ ok: false, error: result.message, code: result.code });
      return;
    }
    res
      .status(200)
      .set(NO_STORE)
      .json({ ok: true, email: result.email, role: result.role });
  });

  router.post("/api/auth/accept-invite", async (req, res) => {
    if (!isAuthConfigured()) {
      res.status(503).set(NO_STORE).json({
        ok: false,
        error: "Authentication is not configured.",
        code: "AUTH_NOT_CONFIGURED",
      });
      return;
    }

    const body = (req.body ?? {}) as {
      token?: string;
      password?: string;
      confirmPassword?: string;
    };
    const token = (body.token ?? "").trim();
    const password = body.password ?? "";

    if (!token) {
      res.status(400).set(NO_STORE).json({
        ok: false,
        error: "This invite link is missing its token.",
        code: "INVITE_INVALID",
      });
      return;
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      res
        .status(400)
        .set(NO_STORE)
        .json({ ok: false, error: passwordError, code: "VALIDATION" });
      return;
    }
    if (
      body.confirmPassword !== undefined &&
      body.confirmPassword !== password
    ) {
      res.status(400).set(NO_STORE).json({
        ok: false,
        error: "Passwords do not match.",
        code: "VALIDATION",
      });
      return;
    }

    try {
      const { user } = await acceptInvite({ token, password });
      const sessionToken = await createSessionToken({
        uid: user.id,
        username: user.email,
        role: user.role,
      });
      res
        .status(201)
        .set(NO_STORE)
        .set("Set-Cookie", buildSessionCookie(sessionToken))
        .json({ ok: true, username: user.email, role: user.role });
    } catch (error) {
      const e = error as Partial<InviteError>;
      const status = typeof e.status === "number" ? e.status : 400;
      res.status(status).set(NO_STORE).json({
        ok: false,
        error: e.message ?? "Could not complete the invite.",
        code: e.code ?? "INVITE_FAILED",
      });
    }
  });

  return router;
}
