/**
 * Shared harness for the RBAC / auth test suites (Phase 5).
 *
 * Matches the existing `scripts/verify-*.ts` convention: plain tsx scripts,
 * a tiny assert + runner, real Postgres via getDbClient, no test-framework
 * dependency. Runs inside the ara-dashboard container where POSTGRES_URL,
 * ARA_SESSION_SECRET and ARA_DASHBOARD_PASSWORD are set.
 *
 * Route handlers are imported and invoked directly with a constructed Request
 * (the same technique as scripts/verify-phase85-dashboard-integration.ts) — so
 * the handler-level `authorizeRequest` gate is exercised for real. proxy.ts is
 * exercised separately in verify-rbac-access-matrix.ts.
 *
 * SAFETY: every fixture email uses the `rbactest.` local-part prefix. The suites
 * never read or write the two real accounts. cleanup() runs before and after.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

/* ------------------------------- env + stubs ------------------------------ */

export async function loadEnv(): Promise<void> {
  for (const name of [".env.local", ".env"]) {
    try {
      const content = await fs.readFile(
        path.join(process.cwd(), name),
        "utf8"
      );
      for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq < 1) continue;
        const k = t.slice(0, eq).trim();
        const v = t
          .slice(eq + 1)
          .trim()
          .replace(/^["']|["']$/g, "");
        if (k && !(k in process.env)) process.env[k] = v;
      }
    } catch {
      /* optional */
    }
  }
  process.env.ARA_PERSISTENCE = "postgres";
  stubServerOnly();
}

function stubServerOnly(): void {
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve("server-only");
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports: {},
      children: [],
      paths: [],
    } as unknown as NodeModule;
  } catch {
    /* not installed — fine */
  }
}

/* ------------------------------- assertions ------------------------------ */

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/* -------------------------------- runner -------------------------------- */

export type TestResult = { suite: string; name: string; ok: boolean; detail?: string };

export class Suite {
  readonly results: TestResult[] = [];
  constructor(private readonly name: string) {}

  async test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      this.results.push({ suite: this.name, name, ok: true });
      console.log(`  PASS  ${name}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.results.push({ suite: this.name, name, ok: false, detail });
      console.error(`  FAIL  ${name}\n        ${detail}`);
    }
  }
}

/* ---------------------------- session tokens ---------------------------- */

const SESSION_TTL_SECONDS = 60 * 60 * 12;
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmac(payloadB64: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  return b64url(new Uint8Array(sig));
}

export type Role = "viewer" | "editor" | "admin" | "super_admin";

/**
 * Mint a session token exactly like src/lib/auth/session.ts, but with a
 * controllable issued-at (issuedSecondsAgo). issuedSecondsAgo=0 => "just now".
 */
export async function mintToken(
  user: { id: string; email: string; role: Role },
  issuedSecondsAgo = 0
): Promise<string> {
  const secret = (process.env.ARA_SESSION_SECRET ?? "").trim();
  if (!secret) throw new Error("ARA_SESSION_SECRET not set");
  const nowSec = Math.floor(Date.now() / 1000) - issuedSecondsAgo;
  const payload = {
    v: 1,
    uid: user.id,
    username: user.email,
    role: user.role,
    exp: nowSec + SESSION_TTL_SECONDS,
  };
  const payloadB64 = b64url(enc.encode(JSON.stringify(payload)));
  return `${payloadB64}.${await hmac(payloadB64, secret)}`;
}

export async function cookieFor(
  user: { id: string; email: string; role: Role },
  issuedSecondsAgo = 0
): Promise<string> {
  return `ara_session=${await mintToken(user, issuedSecondsAgo)}`;
}

/* ------------------------------ HTTP helper ---------------------------- */

export function req(
  pathname: string,
  opts: { method?: string; cookie?: string; body?: unknown } = {}
): Request {
  const init: RequestInit = { method: opts.method ?? "GET" };
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  init.headers = headers;
  return new Request(`http://localhost${pathname}`, init);
}

export async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return { __raw: text.slice(0, 200) };
  }
}

/* --------------------------- fixtures + cleanup ------------------------ */

export const TEST_PREFIX = "rbactest.";
export const TEST_PASSWORD = "TestPass123!";

export type Db = Awaited<ReturnType<typeof openDb>>;

export async function openDb() {
  const { getDbClient } = await import("../src/lib/persistence/db-client");
  return getDbClient();
}

export async function closeDb(): Promise<void> {
  const { closeDbClient } = await import("../src/lib/persistence/db-client");
  await closeDbClient();
}

export type Fixture = {
  id: string;
  email: string;
  role: Role;
  active: boolean;
};

export function testEmail(tag = ""): string {
  return `${TEST_PREFIX}${tag}${tag ? "." : ""}${randomUUID().slice(0, 8)}@araresources.com`;
}

export async function createUser(
  db: Db,
  opts: { role: Role; active?: boolean; email?: string; password?: string }
): Promise<Fixture> {
  const { hashPassword } = await import("../src/lib/auth/passwords");
  const email = (opts.email ?? testEmail(opts.role)).toLowerCase();
  const hash = await hashPassword(opts.password ?? TEST_PASSWORD);
  const rows = await db<{ id: string }[]>`
    INSERT INTO users (email, password_hash, role, active)
    VALUES (${email}, ${hash}, ${opts.role}, ${opts.active ?? true})
    RETURNING id
  `;
  return {
    id: String(rows[0]!.id),
    email,
    role: opts.role,
    active: opts.active ?? true,
  };
}

export async function getUserRow(
  db: Db,
  email: string
): Promise<{ id: string; role: string; active: boolean; password_hash: string } | null> {
  const rows = await db<
    { id: string; role: string; active: boolean; password_hash: string }[]
  >`
    SELECT id, role, active, password_hash FROM users WHERE LOWER(email) = ${email.toLowerCase()} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function countUsers(db: Db, email: string): Promise<number> {
  const rows = await db<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM users WHERE LOWER(email) = ${email.toLowerCase()}
  `;
  return Number(rows[0]!.n);
}

/** Force the 10s auth-state cache to forget a user (deactivation / role tests). */
export async function invalidate(userId: string): Promise<void> {
  const { invalidateAuthState } = await import("../src/lib/auth/users-db");
  invalidateAuthState(userId);
}

export async function cleanup(db: Db): Promise<void> {
  await db`DELETE FROM invites WHERE LOWER(email) LIKE ${TEST_PREFIX + "%@araresources.com"}`;
  await db`DELETE FROM users   WHERE LOWER(email) LIKE ${TEST_PREFIX + "%@araresources.com"}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
