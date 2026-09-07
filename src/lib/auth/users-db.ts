/**
 * PostgreSQL-backed dashboard user store (Phase 2).
 *
 * Replaces the JSON `.data/dashboard-users.json` store for authentication.
 * Node.js runtime only (imports the `postgres` client). Safe to import from
 * Route Handlers, the DAL, and `proxy.ts` (which runs on the Node.js runtime
 * in Next.js 16).
 */
import { getDbClient } from "@/lib/persistence/db-client";
import { hashPassword, verifyPasswordHash } from "@/lib/auth/passwords";
import { isRole, LEAST_PRIVILEGED_ROLE, type Role } from "@/lib/auth/roles";

export type AuthUser = {
  id: string;
  email: string;
  role: Role;
  active: boolean;
  passwordHash: string;
  displayName: string | null;
  avatarUrl: string | null;
};

/** Minimal shape used for per-request authorization (no password hash). */
export type AuthState = {
  id: string;
  email: string;
  role: Role;
  active: boolean;
  /** Phase 4: tokens minted before this are rejected (see session-freshness.ts). */
  passwordChangedAt: string | null;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function rowToAuthUser(row: Record<string, unknown>): AuthUser {
  const rawRole = String(row.role ?? "");
  return {
    id: String(row.id),
    email: String(row.email ?? ""),
    // Unknown / corrupt role in DB → fail closed to least privilege.
    role: isRole(rawRole) ? rawRole : LEAST_PRIVILEGED_ROLE,
    active: row.active === true,
    passwordHash: String(row.password_hash ?? ""),
    displayName: row.display_name == null ? null : String(row.display_name),
    avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
  };
}

export async function findAuthUserByEmail(
  email: string
): Promise<AuthUser | null> {
  const key = normalizeEmail(email);
  if (!key) return null;
  const sql = getDbClient();
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, email, role, active, password_hash, display_name, avatar_url
    FROM users
    WHERE LOWER(email) = ${key}
    LIMIT 1
  `;
  return rows[0] ? rowToAuthUser(rows[0]) : null;
}

export async function findAuthStateById(id: string): Promise<AuthState | null> {
  const key = String(id ?? "").trim();
  if (!key) return null;
  const sql = getDbClient();
  const rows = await sql<
    {
      id: string;
      email: string;
      role: string;
      active: boolean;
      password_changed_at: string | Date | null;
    }[]
  >`
    SELECT id, email, role, active, password_changed_at
    FROM users WHERE id = ${key} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    email: String(row.email ?? ""),
    role: isRole(row.role) ? row.role : LEAST_PRIVILEGED_ROLE,
    active: row.active === true,
    passwordChangedAt: row.password_changed_at
      ? new Date(row.password_changed_at).toISOString()
      : null,
  };
}

/**
 * Verify email + password against `users`. Returns the user only when the
 * password matches AND the account is active.
 */
export async function verifyLoginCredentials(
  email: string,
  password: string
): Promise<AuthUser | null> {
  if (!password) return null;
  const user = await findAuthUserByEmail(email);
  if (!user || !user.active) return null;
  const ok = await verifyPasswordHash(password, user.passwordHash);
  return ok ? user : null;
}

/** Stamp last_login_at = NOW() after a successful login. Best-effort. */
export async function recordLogin(userId: string): Promise<void> {
  const sql = getDbClient();
  await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${userId}`;
}

/**
 * Create a self-service (public signup) account. Always role 'viewer'.
 * Phase 3 will add invite-gating / hardening — this is just the transitional
 * PG write so signup keeps working now that login is PG-only.
 */
export async function createSignupUser(input: {
  email: string;
  password: string;
}): Promise<AuthUser> {
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  const sql = getDbClient();
  const rows = await sql<Record<string, unknown>[]>`
    INSERT INTO users (email, password_hash, role, active)
    VALUES (${email}, ${passwordHash}, 'viewer', TRUE)
    ON CONFLICT (email) DO NOTHING
    RETURNING id, email, role, active, password_hash, display_name, avatar_url
  `;
  if (rows.length === 0) {
    const error = new Error("An account with this email already exists.");
    (error as Error & { code?: string }).code = "USER_EXISTS";
    throw error;
  }
  return rowToAuthUser(rows[0]!);
}

/* ------------------------------------------------------------------ *
 * Short-lived per-request authorization cache.
 *
 * proxy.ts + the DAL call findAuthStateById on every authenticated request.
 * A tiny TTL cache keeps that to one indexed lookup per user per ~10s while
 * still reflecting role changes / deactivation within seconds (requirement:
 * "a role change or account deactivation takes effect without waiting for the
 * session to naturally expire").
 * ------------------------------------------------------------------ */
const AUTH_STATE_TTL_MS = 10_000;
const authStateCache = new Map<string, { at: number; state: AuthState | null }>();

export async function getLiveAuthState(userId: string): Promise<AuthState | null> {
  const now = Date.now();
  const hit = authStateCache.get(userId);
  if (hit && now - hit.at < AUTH_STATE_TTL_MS) {
    return hit.state;
  }
  const state = await findAuthStateById(userId);
  authStateCache.set(userId, { at: now, state });
  // Opportunistic cleanup so the map can't grow unbounded.
  if (authStateCache.size > 500) {
    for (const [key, value] of authStateCache) {
      if (now - value.at >= AUTH_STATE_TTL_MS) authStateCache.delete(key);
    }
  }
  return state;
}

/** Force-refresh a user's cached auth state (call after role/active changes). */
export function invalidateAuthState(userId: string): void {
  authStateCache.delete(userId);
}
