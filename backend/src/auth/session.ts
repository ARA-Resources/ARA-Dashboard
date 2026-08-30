import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "ara_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

export type SessionRole = "viewer" | "operator";

export type DashboardSession = {
  v: 1;
  username: string;
  role: SessionRole;
  exp: number;
};

export function getSessionSecret(): string {
  return process.env.ARA_SESSION_SECRET?.trim() ?? "";
}

function getDashboardPassword(): string {
  return process.env.ARA_DASHBOARD_PASSWORD?.trim() ?? "";
}

/**
 * Matches Next.js isAuthConfigured(): both env vars must be present.
 * Stage 5B does not verify passwords; login remains on Next.js.
 */
export function isAuthConfigured(): boolean {
  return Boolean(getSessionSecret() && getDashboardPassword());
}

export function parseOperatorAllowlist(): string[] {
  return (process.env.ARA_OPERATOR_ALLOWLIST ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
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
  const digest = createHmac("sha256", secret).update(payloadB64, "utf8").digest();
  return toBase64Url(digest);
}

function isSessionRole(value: unknown): value is SessionRole {
  return value === "viewer" || value === "operator";
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
      username?: unknown;
      role?: unknown;
      exp?: unknown;
    };
    if (parsed.v !== 1) return null;
    if (typeof parsed.username !== "string" || !parsed.username) return null;
    if (!isSessionRole(parsed.role)) return null;
    if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp)) {
      return null;
    }
    if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return {
      v: 1,
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
