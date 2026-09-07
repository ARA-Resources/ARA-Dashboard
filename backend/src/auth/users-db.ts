/**
 * PostgreSQL-backed user auth for the Express layer.
 * Mirror of src/lib/auth/users-db.ts. Uses backend/src/db.ts (`pg`).
 *
 * NOTE: the Express layer is not deployed today. It reads PG* env vars
 * (PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD), not POSTGRES_URL.
 */
import { queryRows } from "../db.js";
import { hashPassword, verifyPasswordHash } from "./passwords.js";
import { isRole, LEAST_PRIVILEGED_ROLE, type Role } from "./roles.js";

export type AuthUser = {
  id: string;
  email: string;
  role: Role;
  active: boolean;
  passwordHash: string;
};

export type AuthState = {
  id: string;
  email: string;
  role: Role;
  active: boolean;
  /** Phase 4: tokens minted before this are rejected (session-freshness.ts). */
  passwordChangedAt: string | null;
};

type UserRow = {
  id: string;
  email: string;
  role: string;
  active: boolean;
  password_hash: string;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findAuthUserByEmail(
  email: string
): Promise<AuthUser | null> {
  const key = normalizeEmail(email);
  if (!key) return null;
  const rows = await queryRows<UserRow>(
    `SELECT id, email, role, active, password_hash
     FROM users WHERE LOWER(email) = $1 LIMIT 1`,
    [key]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    email: String(row.email ?? ""),
    role: isRole(row.role) ? row.role : LEAST_PRIVILEGED_ROLE,
    active: row.active === true,
    passwordHash: String(row.password_hash ?? ""),
  };
}

export async function findAuthStateById(id: string): Promise<AuthState | null> {
  const key = String(id ?? "").trim();
  if (!key) return null;
  const rows = await queryRows<
    Omit<UserRow, "password_hash"> & {
      password_changed_at: string | Date | null;
    }
  >(
    `SELECT id, email, role, active, password_changed_at
     FROM users WHERE id = $1 LIMIT 1`,
    [key]
  );
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

export async function recordLogin(userId: string): Promise<void> {
  await queryRows(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [
    userId,
  ]);
}

/** Public signup — always role 'viewer'. Mirror of the Next.js side. */
export async function createSignupUser(input: {
  email: string;
  password: string;
}): Promise<AuthUser> {
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  const rows = await queryRows<UserRow>(
    `INSERT INTO users (email, password_hash, role, active)
     VALUES ($1, $2, 'viewer', TRUE)
     ON CONFLICT (email) DO NOTHING
     RETURNING id, email, role, active, password_hash`,
    [email, passwordHash]
  );
  const row = rows[0];
  if (!row) {
    const error = new Error("An account with this email already exists.");
    (error as Error & { code?: string }).code = "USER_EXISTS";
    throw error;
  }
  return {
    id: String(row.id),
    email: String(row.email ?? ""),
    role: isRole(row.role) ? row.role : LEAST_PRIVILEGED_ROLE,
    active: row.active === true,
    passwordHash: String(row.password_hash ?? ""),
  };
}

const AUTH_STATE_TTL_MS = 10_000;
const cache = new Map<string, { at: number; state: AuthState | null }>();

export async function getLiveAuthState(
  userId: string
): Promise<AuthState | null> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && now - hit.at < AUTH_STATE_TTL_MS) return hit.state;
  const state = await findAuthStateById(userId);
  cache.set(userId, { at: now, state });
  return state;
}
