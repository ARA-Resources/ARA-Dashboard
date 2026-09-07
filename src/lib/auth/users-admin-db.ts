/**
 * Admin + self-service user operations (Phase 4).
 *
 * Kept separate from src/lib/auth/users-db.ts (Phase 2 auth path) so the
 * per-request auth hot path stays untouched. Node.js runtime only.
 *
 * Access control lives in the Route Handlers via authorizeRequest() — these
 * functions assume the caller is already authorized.
 */
import { getDbClient } from "@/lib/persistence/db-client";
import { hashPassword, verifyPasswordHash } from "@/lib/auth/passwords";
import { isRole, type Role } from "@/lib/auth/roles";
import {
  isAssignableRole,
  type AssignableRole,
} from "@/lib/auth/assignable-roles";
import { invalidateAuthState } from "@/lib/auth/users-db";
import { isAvatarColor } from "@/lib/auth/avatar";

export { isAssignableRole };
export type { AssignableRole };

export type AdminError = Error & { code: string; status: number };

function adminError(code: string, status: number, message: string): AdminError {
  const err = new Error(message) as AdminError;
  err.code = code;
  err.status = status;
  return err;
}

export type UserSummary = {
  id: string;
  email: string;
  role: Role;
  active: boolean;
  displayName: string | null;
  avatarColor: string | null;
  lastLoginAt: string | null;
  createdAt: string;
};

type UserSummaryRow = {
  id: string;
  email: string;
  role: string;
  active: boolean;
  display_name: string | null;
  avatar_color: string | null;
  last_login_at: string | Date | null;
  created_at: string | Date;
};

function toIso(v: string | Date | null): string | null {
  return v ? new Date(v).toISOString() : null;
}

function rowToSummary(row: UserSummaryRow): UserSummary {
  return {
    id: String(row.id),
    email: String(row.email ?? ""),
    role: isRole(row.role) ? row.role : "viewer",
    active: row.active === true,
    displayName: row.display_name == null ? null : String(row.display_name),
    avatarColor: row.avatar_color == null ? null : String(row.avatar_color),
    lastLoginAt: toIso(row.last_login_at),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

/** All users, newest first. super_admin only (enforced by the route). */
export async function listAllUsers(): Promise<UserSummary[]> {
  const sql = getDbClient();
  const rows = await sql<UserSummaryRow[]>`
    SELECT id, email, role, active, display_name, avatar_color,
           last_login_at, created_at
    FROM users
    ORDER BY created_at ASC
  `;
  return rows.map(rowToSummary);
}

async function fetchSummary(userId: string): Promise<UserSummary | null> {
  const sql = getDbClient();
  const rows = await sql<UserSummaryRow[]>`
    SELECT id, email, role, active, display_name, avatar_color,
           last_login_at, created_at
    FROM users WHERE id = ${userId} LIMIT 1
  `;
  return rows[0] ? rowToSummary(rows[0]) : null;
}

/**
 * Change another user's role. super_admin only.
 *  - 'viewer' cannot be assigned here (signup-only, matches the invite rule).
 *  - a super_admin cannot change their OWN role (avoids self-lockout from
 *    user management).
 */
export async function updateUserRole(input: {
  targetUserId: string;
  actingUserId: string;
  role: string;
}): Promise<UserSummary> {
  if (!isAssignableRole(input.role)) {
    throw adminError(
      "ROLE_INVALID",
      400,
      "Role must be one of: editor, admin, super_admin. " +
        "viewer accounts are created through public signup, not assigned here."
    );
  }
  if (input.targetUserId === input.actingUserId) {
    throw adminError(
      "SELF_ROLE_CHANGE",
      400,
      "You cannot change your own role."
    );
  }

  const sql = getDbClient();
  const rows = await sql<{ id: string }[]>`
    UPDATE users SET role = ${input.role}
    WHERE id = ${input.targetUserId}
    RETURNING id
  `;
  if (!rows[0]) {
    throw adminError("USER_NOT_FOUND", 404, "That user no longer exists.");
  }
  invalidateAuthState(input.targetUserId);
  const summary = await fetchSummary(input.targetUserId);
  if (!summary) throw adminError("USER_NOT_FOUND", 404, "That user no longer exists.");
  return summary;
}

/**
 * Activate / deactivate a user. super_admin only.
 * A super_admin CANNOT deactivate their own account.
 */
export async function setUserActive(input: {
  targetUserId: string;
  actingUserId: string;
  active: boolean;
}): Promise<UserSummary> {
  if (!input.active && input.targetUserId === input.actingUserId) {
    throw adminError(
      "SELF_DEACTIVATE",
      400,
      "You cannot deactivate your own account."
    );
  }

  const sql = getDbClient();
  const rows = await sql<{ id: string }[]>`
    UPDATE users SET active = ${input.active}
    WHERE id = ${input.targetUserId}
    RETURNING id
  `;
  if (!rows[0]) {
    throw adminError("USER_NOT_FOUND", 404, "That user no longer exists.");
  }
  invalidateAuthState(input.targetUserId);
  const summary = await fetchSummary(input.targetUserId);
  if (!summary) throw adminError("USER_NOT_FOUND", 404, "That user no longer exists.");
  return summary;
}

/**
 * Change the caller's own password. Verifies the current password, re-hashes
 * the new one (scrypt), and stamps password_changed_at so every OTHER session
 * is invalidated on its next request (see session-freshness.ts).
 */
export async function changeOwnPassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  const sql = getDbClient();
  const rows = await sql<{ password_hash: string }[]>`
    SELECT password_hash FROM users WHERE id = ${input.userId} LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw adminError("USER_NOT_FOUND", 404, "Account not found.");

  const ok = await verifyPasswordHash(
    input.currentPassword,
    String(row.password_hash ?? "")
  );
  if (!ok) {
    throw adminError(
      "CURRENT_PASSWORD_WRONG",
      400,
      "Your current password is incorrect."
    );
  }
  if (input.newPassword === input.currentPassword) {
    throw adminError(
      "SAME_PASSWORD",
      400,
      "The new password must be different from the current one."
    );
  }

  const newHash = await hashPassword(input.newPassword);
  await sql`
    UPDATE users
    SET password_hash = ${newHash}, password_changed_at = NOW()
    WHERE id = ${input.userId}
  `;
  invalidateAuthState(input.userId);
}

export type OwnProfile = {
  displayName: string | null;
  avatarColor: string | null;
};

/** Update the caller's own profile (display name + avatar colour). */
export async function updateOwnProfile(input: {
  userId: string;
  displayName?: string | null;
  avatarColor?: string | null;
}): Promise<OwnProfile> {
  const sets: string[] = [];

  let displayName: string | null | undefined;
  if (input.displayName !== undefined) {
    const trimmed = (input.displayName ?? "").trim();
    if (trimmed.length > 80) {
      throw adminError(
        "DISPLAY_NAME_TOO_LONG",
        400,
        "Display name must be 80 characters or fewer."
      );
    }
    displayName = trimmed === "" ? null : trimmed;
    sets.push("display_name");
  }

  let avatarColor: string | null | undefined;
  if (input.avatarColor !== undefined) {
    if (input.avatarColor !== null && !isAvatarColor(input.avatarColor)) {
      throw adminError("AVATAR_COLOR_INVALID", 400, "Unknown avatar colour.");
    }
    avatarColor = input.avatarColor;
    sets.push("avatar_color");
  }

  if (sets.length === 0) {
    throw adminError("NOTHING_TO_UPDATE", 400, "No profile fields provided.");
  }

  const sql = getDbClient();
  // Two explicit branches keep the tagged-template parameters simple/safe.
  if (sets.includes("display_name") && sets.includes("avatar_color")) {
    await sql`
      UPDATE users
      SET display_name = ${displayName ?? null}, avatar_color = ${avatarColor ?? null}
      WHERE id = ${input.userId}
    `;
  } else if (sets.includes("display_name")) {
    await sql`
      UPDATE users SET display_name = ${displayName ?? null} WHERE id = ${input.userId}
    `;
  } else {
    await sql`
      UPDATE users SET avatar_color = ${avatarColor ?? null} WHERE id = ${input.userId}
    `;
  }
  invalidateAuthState(input.userId);

  const rows = await sql<
    { display_name: string | null; avatar_color: string | null }[]
  >`
    SELECT display_name, avatar_color FROM users WHERE id = ${input.userId} LIMIT 1
  `;
  const r = rows[0];
  return {
    displayName: r?.display_name == null ? null : String(r.display_name),
    avatarColor: r?.avatar_color == null ? null : String(r.avatar_color),
  };
}

/** Read the caller's own profile (used by GET /api/auth/me extension). */
export async function readOwnProfile(userId: string): Promise<OwnProfile> {
  const sql = getDbClient();
  const rows = await sql<
    { display_name: string | null; avatar_color: string | null }[]
  >`
    SELECT display_name, avatar_color FROM users WHERE id = ${userId} LIMIT 1
  `;
  const r = rows[0];
  return {
    displayName: r?.display_name == null ? null : String(r.display_name),
    avatarColor: r?.avatar_color == null ? null : String(r.avatar_color),
  };
}
