import type { NextFunction, Request, Response } from "express";
import "../types/express-auth.js";
import type { AccessLevel } from "../auth/access.js";
import { roleMeets, type Role } from "../auth/roles.js";
import {
  isAuthConfigured,
  readSessionCookie,
  verifySessionToken,
} from "../auth/session.js";
import { tokenPredatesPasswordChange } from "../auth/session-freshness.js";
import { getLiveAuthState } from "../auth/users-db.js";

const NO_STORE = { "Cache-Control": "no-store" };

function unauthorized(res: Response): void {
  res.status(401).set(NO_STORE).json({
    error: "Unauthorized",
    code: "UNAUTHENTICATED",
  });
}

function forbidden(res: Response, extra?: Record<string, unknown>): void {
  res.status(403).set(NO_STORE).json({
    error: "Forbidden",
    code: "INSUFFICIENT_ROLE",
    ...extra,
  });
}

function deactivated(res: Response): void {
  res.status(403).set(NO_STORE).json({
    error: "This account is deactivated.",
    code: "ACCOUNT_DEACTIVATED",
  });
}

function authNotConfigured(res: Response): void {
  res.status(503).set(NO_STORE).json({
    error: "Authentication is not configured.",
    code: "AUTH_NOT_CONFIGURED",
  });
}

/**
 * @param level minimum role required, or "public".
 * Re-reads role + active from Postgres on every call (10s cache).
 */
export function requireAccess(level: AccessLevel) {
  return async function authMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    if (level === "public") {
      next();
      return;
    }

    // Legacy alias — see backend/src/auth/access.ts.
    const minimumRole: Role = level === "authenticated" ? "viewer" : level;

    if (!isAuthConfigured()) {
      authNotConfigured(res);
      return;
    }

    const token = readSessionCookie(req.headers.cookie ?? null);
    const session = await verifySessionToken(token);
    if (!session) {
      unauthorized(res);
      return;
    }

    const state = await getLiveAuthState(session.uid);
    if (!state) {
      unauthorized(res);
      return;
    }
    if (!state.active) {
      deactivated(res);
      return;
    }
    // Phase 4: a password change signs out every session minted before it.
    if (tokenPredatesPasswordChange(session.exp, state.passwordChangedAt)) {
      unauthorized(res);
      return;
    }
    if (!roleMeets(state.role, minimumRole)) {
      forbidden(res, { required: minimumRole });
      return;
    }

    req.auth = { ...session, role: state.role };
    next();
  };
}
