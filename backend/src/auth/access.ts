export type AccessLevel = "public" | "authenticated" | "operator";

function normalizePath(pathname: string): string {
  if (!pathname) return "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/**
 * Access policy for Node APIs.
 * Stage 8B-1: auth endpoint public/authenticated rules match Next.js.
 * Does not yet reproduce the full Next page/API matrix.
 */
export function requiredAccess(pathname: string, method: string): AccessLevel {
  const path = normalizePath(pathname);
  const verb = method.toUpperCase();

  if (path === "/api/health" && (verb === "GET" || verb === "HEAD")) {
    return "public";
  }
  if (path === "/api/db-health" && (verb === "GET" || verb === "HEAD")) {
    return "public";
  }

  if (path === "/api/auth/login" && (verb === "GET" || verb === "POST")) {
    return "public";
  }
  if (path === "/api/auth/signup" && verb === "POST") {
    return "public";
  }
  if (path === "/api/auth/logout" && verb === "POST") {
    return "authenticated";
  }
  if (path === "/api/auth/me" && verb === "GET") {
    return "authenticated";
  }

  if (
    path === "/api/dataset/lateral/sync-history" &&
    (verb === "GET" || verb === "HEAD")
  ) {
    return "authenticated";
  }

  if (
    path === "/api/dataset/lateral/p-roles" &&
    (verb === "GET" || verb === "HEAD")
  ) {
    return "authenticated";
  }

  if (path.startsWith("/api/")) {
    if (verb === "GET" || verb === "HEAD") return "authenticated";
    return "operator";
  }

  return "authenticated";
}

export function isApiPath(pathname: string): boolean {
  return normalizePath(pathname).startsWith("/api/");
}
