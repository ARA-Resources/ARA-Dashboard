/**
 * Admin + self-service user operations for the Express layer (Phase 4).
 * Mirror of src/lib/auth/users-admin-db.ts. Uses backend/src/db.ts (`pg`).
 * The Express layer is not deployed today.
 */
import { queryRows } from "../db.js";
import { hashPassword, verifyPasswordHash } from "./passwords.js";
import { isRole, type Role } from "./roles.js";

export const ASSIGNABLE_ROLES = ["editor", "admin", "super_admin"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export function isAssignableRole(value: unknown): value is AssignableRole {
  return (
    typeof value === "string" &&
    (ASSIGNABLE_ROLES as readonly string[]).includes(value)
  );
}

const AVATAR_COLORS = [
  "slate",
  "red",
  "amber",
  "green",
  "teal",
  "blue",
  "indigo",
  "violet",
  "pink",
];
function isAvatarColor(v: unknown): v is string {
  return typeof v === "string" && AVATAR_COLORS.includes(v);
}

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

export async function listAllUsers(): Promise<UserSummary[]> {
  const rows = await queryRows<UserSummaryRow>(
    `SELECT id, email, role, active, display_name, avatar_color,
            last_login_at, created_at
     FROM users ORDER BY created_at ASC`
  );
  return rows.map(rowToSummary);
}

async function fetchSummary(userId: string): Promise<UserSummary | null> {
  const rows = await queryRows<UserSummaryRow>(
    `SELECT id, email, role, active, display_name, avatar_color,
            last_login_at, created_at
     FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  return rows[0] ? rowToSummary(rows[0]) : null;
}

export async function updateUserRole(input: {
  targetUserId: string;
  actingUserId: string;
  role: string;
}): Promise<UserSummary> {
  if (!isAssignableRole(input.role)) {
    throw adminError(
      "ROLE_INVALID",
      400,
      "Role must be one of: editor, admin, super_admin."
    );
  }
  if (input.targetUserId === input.actingUserId) {
    throw adminError("SELF_ROLE_CHANGE", 400, "You cannot change your own role.");
  }
  const rows = await queryRows<{ id: string }>(
    `UPDATE users SET role = $1 WHERE id = $2 RETURNING id`,
    [input.role, input.targetUserId]
  );
  if (!rows[0]) throw adminError("USER_NOT_FOUND", 404, "That user no longer exists.");
  const summary = await fetchSummary(input.targetUserId);
  if (!summary) throw adminError("USER_NOT_FOUND", 404, "That user no longer exists.");
  return summary;
}

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
  const rows = await queryRows<{ id: string }>(
    `UPDATE users SET active = $1 WHERE id = $2 RETURNING id`,
    [input.active, input.targetUserId]
  );
  if (!rows[0]) throw adminError("USER_NOT_FOUND", 404, "That user no longer exists.");
  const summary = await fetchSummary(input.targetUserId);
  if (!summary) throw adminError("USER_NOT_FOUND", 404, "That user no longer exists.");
  return summary;
}

export async function changeOwnPassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  const rows = await queryRows<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1 LIMIT 1`,
    [input.userId]
  );
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
  await queryRows(
    `UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2`,
    [newHash, input.userId]
  );
}

export type OwnProfile = {
  displayName: string | null;
  avatarColor: string | null;
};

export async function updateOwnProfile(input: {
  userId: string;
  displayName?: string | null;
  avatarColor?: string | null;
}): Promise<OwnProfile> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (input.displayName !== undefined) {
    const trimmed = (input.displayName ?? "").trim();
    if (trimmed.length > 80) {
      throw adminError(
        "DISPLAY_NAME_TOO_LONG",
        400,
        "Display name must be 80 characters or fewer."
      );
    }
    values.push(trimmed === "" ? null : trimmed);
    fields.push(`display_name = $${values.length}`);
  }
  if (input.avatarColor !== undefined) {
    if (input.avatarColor !== null && !isAvatarColor(input.avatarColor)) {
      throw adminError("AVATAR_COLOR_INVALID", 400, "Unknown avatar colour.");
    }
    values.push(input.avatarColor);
    fields.push(`avatar_color = $${values.length}`);
  }
  if (fields.length === 0) {
    throw adminError("NOTHING_TO_UPDATE", 400, "No profile fields provided.");
  }
  values.push(input.userId);
  await queryRows(
    `UPDATE users SET ${fields.join(", ")} WHERE id = $${values.length}`,
    values
  );
  return readOwnProfile(input.userId);
}

export async function readOwnProfile(userId: string): Promise<OwnProfile> {
  const rows = await queryRows<{
    display_name: string | null;
    avatar_color: string | null;
  }>(
    `SELECT display_name, avatar_color FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  const r = rows[0];
  return {
    displayName: r?.display_name == null ? null : String(r.display_name),
    avatarColor: r?.avatar_color == null ? null : String(r.avatar_color),
  };
}
