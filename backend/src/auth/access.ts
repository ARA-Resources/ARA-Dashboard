/**
 * Access policy for the Express layer — mirror of src/lib/auth/access.ts.
 * Role model: viewer < editor < admin < super_admin. No "operator".
 * "viewer" means "any authenticated, active user".
 */
import type { Role } from "./roles.js";

/**
 * "authenticated" is a legacy alias for "viewer" (any signed-in active user),
 * kept so existing `requireAccess("authenticated")` call sites in
 * backend/src/routes/* keep working. When the Express layer is revived, those
 * call sites should be tightened to the exact role from requiredAccess() —
 * e.g. Dataset routes are "editor", not "viewer".
 */
export type AccessLevel = "public" | "authenticated" | Role;

const OPERATOR_LEGACY_GET_PATHS = new Set<string>([
  "/api/dataset/gmail/oauth/start",
  "/api/dataset/gmail/messages",
  "/api/dataset/gmail/sync",
]);

const SUPER_ADMIN_API_PREFIXES = ["/api/admin/users", "/api/admin/invites"];

function normalizePath(pathname: string): string {
  if (!pathname) return "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

export function isApiPath(pathname: string): boolean {
  return normalizePath(pathname).startsWith("/api/");
}

export function requiredAccess(pathname: string, method: string): AccessLevel {
  const path = normalizePath(pathname);
  const verb = method.toUpperCase();
  const isRead = verb === "GET" || verb === "HEAD";

  if (path === "/api/health" && isRead) return "public";
  if (path === "/api/db-health" && isRead) return "public";
  if (path === "/api/auth/login" && (isRead || verb === "POST")) return "public";
  if (path === "/api/auth/signup" && verb === "POST") return "public";
  // Phase 3 — invite acceptance (invited person has no session yet).
  if (path === "/api/auth/accept-invite" && (isRead || verb === "POST")) {
    return "public";
  }
  if (path === "/api/dataset/gmail/oauth/callback" && isRead) return "public";

  if (path === "/api/auth/logout" || path === "/api/auth/me") return "viewer";
  // Phase 4: self-service account actions — any authenticated user, own account.
  if (path === "/api/auth/change-password" && verb === "POST") return "viewer";
  if (path === "/api/auth/profile" && verb === "POST") return "viewer";
  if (path === "/api/dataset/notifications") return "viewer";
  if (path === "/api/home/widgets" && isRead) return "viewer";
  if (path.startsWith("/api/excel/") && isRead) return "viewer";
  if (path === "/api/dataset/lateral/p-roles" && isRead) return "viewer";

  if (
    SUPER_ADMIN_API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
  ) {
    return "super_admin";
  }

  if (OPERATOR_LEGACY_GET_PATHS.has(path)) return "editor";
  if (path === "/api/cron/lateral") return "editor";
  if (path.startsWith("/api/dataset/")) return "editor";

  if (isApiPath(path)) return isRead ? "viewer" : "editor";

  return "viewer";
}
