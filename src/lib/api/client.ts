/**
 * Thin browser API client for Stage 7+ Node backend integration.
 *
 * When NEXT_PUBLIC_ARA_API_BASE_URL is unset/empty, requests stay same-origin
 * (Next.js Route Handlers). When set, requests go to the Express backend.
 *
 * Never put secrets in NEXT_PUBLIC_* variables.
 */

function normalizeBaseUrl(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  return trimmed;
}

/** Public API origin for browser calls. Empty = same-origin Next.js. */
export function getApiBaseUrl(): string {
  return normalizeBaseUrl(process.env.NEXT_PUBLIC_ARA_API_BASE_URL);
}

/**
 * Build an absolute or relative URL for an `/api/...` path.
 * `path` must start with `/`.
 */
export function apiUrl(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`apiUrl path must start with "/": ${path}`);
  }
  const base = getApiBaseUrl();
  return base ? `${base}${path}` : path;
}

export type ApiFetchInit = RequestInit & {
  /** Defaults to true so `ara_session` is sent to Node when cross-origin. */
  includeCredentials?: boolean;
};

/**
 * fetch wrapper for dashboard APIs.
 * Always uses credentials by default (cookie session from Stage 5).
 */
export async function apiFetch(
  path: string,
  init: ApiFetchInit = {}
): Promise<Response> {
  const { includeCredentials = true, ...rest } = init;
  return fetch(apiUrl(path), {
    ...rest,
    credentials: includeCredentials ? "include" : rest.credentials,
  });
}
