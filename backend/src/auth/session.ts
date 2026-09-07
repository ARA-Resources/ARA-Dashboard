import { createHmac, timingSafeEqual } from "node:crypto";
import { isRole, type Role } from "./roles.js";

export const SESSION_COOKIE = "ara_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

/** @deprecated alias — use `Role` from "./roles.js". */
export type SessionRole = Role;

export type DashboardSession = {
  v: 1;
  uid: string;
  username: string;
  role: Role;
  exp: number;
};

export function getSessionSecret(): string {
  return process.env.ARA_SESSION_SECRET?.trim() ?? "";
}

export function getDashboardPassword(): string {
  return process.env.ARA_DASHBOARD_PASSWORD?.trim() ?? "";
}

export function isAuthConfigured(): boolean {
  return Boolean(getSessionSecret() && getDashboardPassword());
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const pad =
      padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const buf = Buffer.from(padded + pad, "base64");
    if (buf.length === 0 && value.length > 0) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function signPayload(payloadB64: string, secret: string): string {
  const digest = createHmac("sha256", secret)
    .update(payloadB64, "utf8")
    .digest();
  return toBase64Url(digest);
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
  const payloadB64 = toBase64Url(
    new TextEncoder().encode(JSON.stringify(session))
  );
  const sig = signPayload(payloadB64, secret);
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
  const expected = signPayload(payloadB64, secret);
  const a = fromBase64Url(sig);
  const b = fromBase64Url(expected);
  if (!a || !b || !safeEqual(a, b)) return null;
  const raw = fromBase64Url(payloadB64);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as {
      v?: unknown;
      uid?: unknown;
      username?: unknown;
      role?: unknown;
      exp?: unknown;
    };
    if (parsed.v !== 1) return null;
    if (typeof parsed.uid !== "string" || !parsed.uid) return null;
    if (typeof parsed.username !== "string" || !parsed.username) return null;
    if (!isRole(parsed.role)) return null;
    if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp)) {
      return null;
    }
    if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
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
      try {
        return decodeURIComponent(trimmed.slice(SESSION_COOKIE.length + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
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
