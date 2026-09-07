/**
 * Dashboard session cookies (HMAC-SHA256). Edge-safe (Web Crypto).
 * Separate from Gmail/Drive OAuth tokens.
 *
 * Phase 2: the token carries the user's Postgres id (`uid`) and the role that
 * was current at login. The role in the token is only an OPTIMISTIC hint —
 * every authoritative check re-reads role + active from the `users` table
 * (see src/lib/auth/dal.ts). Tokens minted before Phase 2 (no `uid`, legacy
 * role) fail verification and force a fresh login.
 */
import { isRole, type Role } from "@/lib/auth/roles";

export const SESSION_COOKIE = "ara_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

/** @deprecated Use `Role` from "@/lib/auth/roles". Kept as an alias only. */
export type SessionRole = Role;

export type DashboardSession = {
  v: 1;
  /** Postgres users.id (UUID). Required since Phase 2. */
  uid: string;
  username: string;
  role: Role;
  exp: number;
};

function textEncoder() {
  return new TextEncoder();
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const bin = atob(padded + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

export function getSessionSecret(): string {
  return process.env.ARA_SESSION_SECRET?.trim() ?? "";
}

export function getDashboardPassword(): string {
  return process.env.ARA_DASHBOARD_PASSWORD?.trim() ?? "";
}

/**
 * Both env vars must be present for auth to be considered configured.
 * NOTE (Phase 2): ARA_DASHBOARD_PASSWORD is no longer accepted as a login
 * credential — it only gates this "configured" flag. It can be retired in a
 * later phase once nothing else references it.
 */
export function isAuthConfigured(): boolean {
  return Boolean(getSessionSecret() && getDashboardPassword());
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function signPayload(payloadB64: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder().encode(payloadB64)
  );
  return toBase64Url(new Uint8Array(sig));
}

export async function createSessionToken(input: {
  uid: string;
  username: string;
  role: Role;
}): Promise<string> {
  const secret = getSessionSecret();
  if (!secret) {
    throw new Error("ARA_SESSION_SECRET is not configured.");
  }
  const session: DashboardSession = {
    v: 1,
    uid: input.uid,
    username: input.username.trim(),
    role: input.role,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const payloadB64 = toBase64Url(textEncoder().encode(JSON.stringify(session)));
  const sig = await signPayload(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

export async function verifySessionToken(
  token: string | undefined | null
): Promise<DashboardSession | null> {
  if (!token) return null;
  const secret = getSessionSecret();
  if (!secret) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await signPayload(payloadB64, secret);
  const a = fromBase64Url(sig);
  const b = fromBase64Url(expected);
  if (!a || !b || !timingSafeEqual(a, b)) return null;
  const raw = fromBase64Url(payloadB64);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as Partial<DashboardSession>;
    if (parsed.v !== 1) return null;
    if (typeof parsed.uid !== "string" || !parsed.uid) return null;
    if (typeof parsed.username !== "string" || !parsed.username) return null;
    if (!isRole(parsed.role)) return null;
    if (typeof parsed.exp !== "number" || parsed.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return {
      v: 1,
      uid: parsed.uid,
      username: parsed.username,
      role: parsed.role,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE}=`)) {
      return decodeURIComponent(trimmed.slice(SESSION_COOKIE.length + 1));
    }
  }
  return null;
}

export async function getSessionFromRequest(
  request: Request
): Promise<DashboardSession | null> {
  const token = readSessionCookie(request.headers.get("cookie"));
  return verifySessionToken(token);
}

export function sessionCookieSecure(): boolean {
  const appUrl = (
    process.env.ARA_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    ""
  ).replace(/\/$/, "");
  return appUrl.startsWith("https://");
}

export function buildSessionCookie(token: string): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (sessionCookieSecure()) parts.push("Secure");
  return parts.join("; ");
}

export function buildExpiredSessionCookie(): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (sessionCookieSecure()) parts.push("Secure");
  return parts.join("; ");
}
