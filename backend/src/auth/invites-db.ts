/**
 * PostgreSQL-backed invite store for the Express layer (Phase 3).
 * Mirror of src/lib/auth/invites-db.ts. Uses backend/src/db.ts (`pg`).
 *
 * NOTE: the Express layer is not deployed today. It reads PG* env vars.
 *
 * `pg` (via queryRows) has no transaction helper here, so single-use safety
 * comes from an atomic conditional UPDATE that claims the token
 * (`... WHERE used_at IS NULL AND expires_at > NOW() RETURNING`).
 */
import { randomBytes } from "node:crypto";
import { queryRows } from "../db.js";
import { hashPassword } from "./passwords.js";
import { isRole, type Role } from "./roles.js";

export const INVITABLE_ROLES = ["editor", "admin", "super_admin"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export function isInvitableRole(value: unknown): value is InvitableRole {
  return (
    typeof value === "string" &&
    (INVITABLE_ROLES as readonly string[]).includes(value)
  );
}

const DEFAULT_EXPIRY_DAYS = 7;
const MAX_EXPIRY_DAYS = 30;
const TOKEN_BYTES = 32;

export type InviteError = Error & { code: string; status: number };

function inviteError(code: string, status: number, message: string): InviteError {
  const err = new Error(message) as InviteError;
  err.code = code;
  err.status = status;
  return err;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function looksLikeEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

export type InviteRecord = {
  id: string;
  email: string;
  role: Role;
  token: string;
  expiresAt: string;
  usedAt: string | null;
  createdBy: string | null;
  createdAt: string;
};

type InviteRow = {
  id: string;
  email: string;
  role: string;
  token: string;
  expires_at: string | Date;
  used_at: string | Date | null;
  created_by: string | null;
  created_at: string | Date;
};

function rowToInvite(row: InviteRow): InviteRecord {
  return {
    id: String(row.id),
    email: String(row.email ?? ""),
    role: isRole(row.role) ? row.role : "viewer",
    token: String(row.token ?? ""),
    expiresAt: new Date(row.expires_at).toISOString(),
    usedAt: row.used_at ? new Date(row.used_at).toISOString() : null,
    createdBy: row.created_by == null ? null : String(row.created_by),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function createInvite(input: {
  email: string;
  role: string;
  createdBy: string | null;
  expiresInDays?: number;
}): Promise<InviteRecord> {
  const email = normalizeEmail(input.email);
  if (!looksLikeEmail(email)) {
    throw inviteError("EMAIL_INVALID", 400, "Enter a valid email address.");
  }
  if (!isInvitableRole(input.role)) {
    throw inviteError(
      "ROLE_INVALID",
      400,
      "Invite role must be one of: editor, admin, super_admin. " +
        "viewer accounts are created through public signup, not invites."
    );
  }

  const days =
    typeof input.expiresInDays === "number" &&
    Number.isFinite(input.expiresInDays) &&
    input.expiresInDays > 0
      ? Math.min(Math.floor(input.expiresInDays), MAX_EXPIRY_DAYS)
      : DEFAULT_EXPIRY_DAYS;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const existing = await queryRows<{ id: string }>(
    `SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1`,
    [email]
  );
  if (existing[0]) {
    throw inviteError(
      "USER_EXISTS",
      409,
      "A user with this email already exists. Change their role directly instead of inviting them."
    );
  }

  await queryRows(
    `DELETE FROM invites WHERE LOWER(email) = $1 AND used_at IS NULL`,
    [email]
  );

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const rows = await queryRows<InviteRow>(
    `INSERT INTO invites (email, role, token, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, role, token, expires_at, used_at, created_by, created_at`,
    [email, input.role, token, expiresAt.toISOString(), input.createdBy]
  );
  return rowToInvite(rows[0]!);
}

export type PendingInviteLookup =
  | { ok: true; email: string; role: Role }
  | { ok: false; code: string; status: number; message: string };

export async function findPendingInvite(
  token: string
): Promise<PendingInviteLookup> {
  const value = (token ?? "").trim();
  if (!value) {
    return {
      ok: false,
      code: "INVITE_INVALID",
      status: 400,
      message: "This invite link is missing its token.",
    };
  }
  const rows = await queryRows<InviteRow>(
    `SELECT email, role, expires_at, used_at FROM invites WHERE token = $1 LIMIT 1`,
    [value]
  );
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      code: "INVITE_INVALID",
      status: 404,
      message: "This invite link is not valid.",
    };
  }
  if (row.used_at) {
    return {
      ok: false,
      code: "INVITE_USED",
      status: 410,
      message: "This invite link has already been used.",
    };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return {
      ok: false,
      code: "INVITE_EXPIRED",
      status: 410,
      message: "This invite link has expired. Ask a super admin for a new one.",
    };
  }
  const role = isRole(row.role) ? row.role : null;
  if (!role || role === "viewer") {
    return {
      ok: false,
      code: "INVITE_INVALID",
      status: 400,
      message: "This invite is misconfigured. Ask a super admin for a new one.",
    };
  }
  return { ok: true, email: String(row.email ?? ""), role };
}

export type AcceptedInvite = {
  user: { id: string; email: string; role: Role };
};

export async function acceptInvite(input: {
  token: string;
  password: string;
}): Promise<AcceptedInvite> {
  const token = (input.token ?? "").trim();
  if (!token) {
    throw inviteError("INVITE_INVALID", 400, "This invite link is missing its token.");
  }

  // Reason for a non-generic failure.
  const probe = await findPendingInvite(token);
  if (!probe.ok) {
    throw inviteError(probe.code, probe.status, probe.message);
  }

  const email = probe.email.trim().toLowerCase();
  const existing = await queryRows<{ id: string }>(
    `SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1`,
    [email]
  );
  if (existing[0]) {
    throw inviteError(
      "USER_EXISTS",
      409,
      "An account with this email already exists. Try signing in instead."
    );
  }

  // Atomic single-use claim: only one caller can flip used_at from NULL.
  const claimed = await queryRows<{ id: string; email: string; role: string }>(
    `UPDATE invites SET used_at = NOW()
     WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING id, email, role`,
    [token]
  );
  const invite = claimed[0];
  if (!invite) {
    // Lost the race, or it expired between the probe and the claim.
    const after = await findPendingInvite(token);
    if (!after.ok) throw inviteError(after.code, after.status, after.message);
    throw inviteError("INVITE_USED", 410, "This invite link has already been used.");
  }

  const role = isRole(invite.role) ? (invite.role as Role) : probe.role;
  const passwordHash = await hashPassword(input.password);

  try {
    const userRows = await queryRows<{ id: string; email: string; role: string }>(
      `INSERT INTO users (email, password_hash, role, active)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id, email, role`,
      [email, passwordHash, role]
    );
    const created = userRows[0]!;
    return {
      user: {
        id: String(created.id),
        email: String(created.email ?? email),
        role: isRole(created.role) ? (created.role as Role) : role,
      },
    };
  } catch (error) {
    // Roll the claim back so the invite can be retried.
    await queryRows(
      `UPDATE invites SET used_at = NULL WHERE id = $1`,
      [invite.id]
    ).catch(() => undefined);
    throw inviteError(
      "USER_EXISTS",
      409,
      "An account with this email already exists. Try signing in instead."
    );
  }
}

export type InviteListEntry = InviteRecord & {
  status: "pending" | "used" | "expired";
};

export async function listRecentInvites(limit = 50): Promise<InviteListEntry[]> {
  const capped = Math.min(Math.max(1, Math.floor(limit) || 50), 200);
  const rows = await queryRows<InviteRow>(
    `SELECT id, email, role, token, expires_at, used_at, created_by, created_at
     FROM invites ORDER BY created_at DESC LIMIT $1`,
    [capped]
  );
  const now = Date.now();
  return rows.map((row) => {
    const record = rowToInvite(row);
    const status: InviteListEntry["status"] = record.usedAt
      ? "used"
      : new Date(record.expiresAt).getTime() <= now
        ? "expired"
        : "pending";
    return { ...record, status };
  });
}
