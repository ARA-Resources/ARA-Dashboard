/**
 * ARA Dashboard access policy (Phase 2 — 4-role model).
 *
 * `requiredAccess(path, method)` returns the MINIMUM role needed, or "public".
 * Consumed by:
 *   - src/proxy.ts  (optimistic gate — compares against the role in the token)
 *   - src/lib/auth/dal.ts  (authoritative gate — compares against the DB role)
 *
 * Role model: viewer < editor < admin < super_admin  (see @/lib/auth/roles).
 * "viewer" here means "any authenticated, active user".
 */
import type { Role } from "@/lib/auth/roles";

export type AccessLevel = "public" | Role;

const OPERATOR_LEGACY_GET_PATHS = new Set<string>([
  // Previously "operator"-only GET/side-effecting endpoints — now "editor".
  "/api/dataset/gmail/oauth/start",
  "/api/dataset/gmail/messages",
  "/api/dataset/gmail/sync",
]);

/** User-management endpoints. Built in Phase 3 — pre-authorized here. */
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

  /* ---------------- Public ---------------- */
  if (path === "/login" || path === "/logout") return "public";
  if (path === "/api/health" && isRead) return "public";
  if (path === "/api/auth/login" && (isRead || verb === "POST")) return "public";
  if (path === "/api/auth/signup" && verb === "POST") return "public";
  // Phase 3 — invite acceptance. The invited person has no session yet; the
  // token in the URL/body is the credential. The handler validates it.
  if (path === "/accept-invite") return "public";
  if (path === "/api/auth/accept-invite" && (isRead || verb === "POST")) {
    return "public";
  }
  // Google redirects here after OAuth; the handler validates the state token.
  if (path === "/api/dataset/gmail/oauth/callback" && isRead) return "public";
  // Cron trigger: proxy also accepts a valid CRON_SECRET bearer (see proxy.ts);
  // a dashboard session needs editor.
  // (falls through to the editor rule below)

  /* ---------------- Authenticated (viewer) ---------------- */
  if (path === "/api/auth/logout" || path === "/api/auth/me") return "viewer";
  // Phase 4: self-service account actions — any authenticated user, own account
  // only (the handlers act solely on the caller's own row).
  if (path === "/api/auth/change-password" && verb === "POST") return "viewer";
  if (path === "/api/auth/profile" && verb === "POST") return "viewer";
  // Navbar notification bell is shared UI for every signed-in user.
  if (path === "/api/dataset/notifications") return "viewer";
  // Home KPIs + Demands (company dashboards) data.
  if (path === "/api/home/widgets" && isRead) return "viewer";
  if (path.startsWith("/api/excel/") && isRead) return "viewer";
  // P-Roles openings feed powers the Demands → Lateral dashboard (read-only).
  if (path === "/api/dataset/lateral/p-roles" && isRead) return "viewer";

  /* ---------------- super_admin (Phase 3 user management) ---------------- */
  if (SUPER_ADMIN_API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
    return "super_admin";
  }

  /* ---------------- editor (all remaining Dataset surface) ---------------- */
  if (OPERATOR_LEGACY_GET_PATHS.has(path)) return "editor";
  if (path === "/api/cron/lateral") return "editor";
  if (path.startsWith("/api/dataset/")) return "editor";

  /* ---------------- Any other /api/* ---------------- */
  if (isApiPath(path)) {
    // Unknown API: read = viewer, write = editor. Fail toward least surprise
    // for reads, toward safety for writes.
    return isRead ? "viewer" : "editor";
  }

  /* ---------------- Pages ---------------- */
  if (path === "/" || path === "/home") return "viewer";
  if (path.startsWith("/company") || path.startsWith("/candidate")) return "viewer";
  // Legacy redirect aliases.
  if (["/overview", "/lateral", "/executive", "/consulting"].includes(path)) {
    return "viewer";
  }
  if (path.startsWith("/dataset")) return "editor";
  if (path.startsWith("/admin")) return "admin";
  // Phase 4: /settings now hosts universal account settings (change password,
  // profile) plus admin-only cards gated in the UI — page itself is viewer.
  if (path.startsWith("/settings")) return "viewer";

  // Default for any unclassified page: must at least be signed in.
  return "viewer";
}
