/**
 * Dashboard + API access policy. Used by middleware only.
 * Does not live inside Lateral pipeline / Gmail / Drive business logic.
 */
export type AccessLevel = "public" | "authenticated" | "operator";

const OPERATOR_GET_PATHS = new Set([
  "/api/dataset/gmail/oauth/start",
  "/api/dataset/gmail/messages",
  "/api/dataset/gmail/sync",
]);

function normalizePath(pathname: string): string {
  if (!pathname) return "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

export function requiredAccess(pathname: string, method: string): AccessLevel {
  const path = normalizePath(pathname);
  const verb = method.toUpperCase();

  if (path === "/login") return "public";
  if (path === "/logout") return "public";

  // Google redirects here after OAuth — must not require a dashboard session.
  // State token validation is mandatory inside the route handler itself.
  if (path === "/api/dataset/gmail/oauth/callback" && verb === "GET") {
    return "public";
  }
  if (path === "/api/health" && (verb === "GET" || verb === "HEAD")) {
    return "public";
  }
  if (path === "/api/auth/login" && (verb === "GET" || verb === "POST")) {
    return "public";
  }
  if (path === "/api/auth/signup" && verb === "POST") {
    return "public";
  }

  if (path === "/api/auth/logout") return "authenticated";
  if (path === "/api/auth/me") return "authenticated";
  if (path === "/api/dataset/notifications" && verb === "POST") {
    return "authenticated";
  }

  if (OPERATOR_GET_PATHS.has(path)) return "operator";

  if (path.startsWith("/api/")) {
    if (verb === "GET" || verb === "HEAD") return "authenticated";
    return "operator";
  }

  return "authenticated";
}

export function isApiPath(pathname: string): boolean {
  return normalizePath(pathname).startsWith("/api/");
}
