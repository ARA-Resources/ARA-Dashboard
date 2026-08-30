import type { NextFunction, Request, Response } from "express";
import "../types/express-auth.js";
import type { AccessLevel } from "../auth/access.js";
import {
  isAuthConfigured,
  readSessionCookie,
  verifySessionToken,
} from "../auth/session.js";

const NO_STORE = { "Cache-Control": "no-store" };

function unauthorized(res: Response): void {
  res.status(401).set(NO_STORE).json({
    error: "Unauthorized",
    code: "UNAUTHENTICATED",
  });
}

function forbidden(res: Response): void {
  res.status(403).set(NO_STORE).json({
    error: "Forbidden",
    code: "INSUFFICIENT_PERMISSION",
  });
}

function authNotConfigured(res: Response): void {
  res.status(503).set(NO_STORE).json({
    error: "Authentication is not configured.",
    code: "AUTH_NOT_CONFIGURED",
  });
}

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

    if (level === "operator" && session.role !== "operator") {
      forbidden(res);
      return;
    }

    req.auth = session;
    next();
  };
}
