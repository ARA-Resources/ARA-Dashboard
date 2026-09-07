/**
 * PostgreSQL-backed invite store (Phase 3).
 *
 * Two deliberately isolated doors into the system:
 *   - public signup → ALWAYS role 'viewer'                (src/lib/auth/users-db.ts)
 *   - invite        → 'editor' | 'admin' | 'super_admin', issued by a super_admin
 *
 * The `invites` table (migration 006) columns used here:
 *   email, role, token (UNIQUE), expires_at, used_at, created_by.
 *
 * Node.js runtime only (imports the `postgres` client).
 */
import { randomBytes } from "node:crypto";
import { getDbClient } from "@/lib/persistence/db-client";
import { hashPassword } from "@/lib/auth/passwords";
import { isRole, type Role } from "@/lib/auth/roles";

/** Roles that may be granted via an invite. 'viewer' is public signup's job. */
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
const TOKEN_BYTES = 32; // 256 bits → 43-char base64url string

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

/** Error carrying an HTTP status + machine code for the Route Handler. */
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

/** Shape of a full `invites` row as returned by postgres.js. */
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

function toIso(value: string | number | Date): string {
  return new Date(value).toISOString();
}

function rowToInvite(row: InviteRow): InviteRecord {
  return {
    id: String(row.id),
    email: String(row.email ?? ""),
    role: isRole(row.role) ? row.role : "viewer",
    token: String(row.token ?? ""),
    expiresAt: toIso(row.expires_at),
    usedAt: row.used_at ? toIso(row.used_at) : null,
    createdBy: row.created_by == null ? null : String(row.created_by),
    createdAt: toIso(row.created_at),
  };
}

/**
 * Create a single-use, expiring invite. Supersedes any earlier *unused* invite
 * for the same email so there is only ever one live token per address.
 *
 * Throws InviteError: EMAIL_INVALID / ROLE_INVALID / USER_EXISTS.
 */
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

  const sql = getDbClient();

  const existingUser = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE LOWER(email) = ${email} LIMIT 1
  `;
  if (existingUser[0]) {
    throw inviteError(
      "USER_EXISTS",
      409,
      "A user with this email already exists. Change their role directly instead of inviting them."
    );
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");

  const inserted = await sql.begin(async (tx) => {
    await tx`
      DELETE FROM invites WHERE LOWER(email) = ${email} AND used_at IS NULL
    `;
    const rows = await tx<InviteRow[]>`
      INSERT INTO invites (email, role, token, expires_at, created_by)
      VALUES (${email}, ${input.role}, ${token}, ${expiresAt}, ${input.createdBy})
      RETURNING id, email, role, token, expires_at, used_at, created_by, created_at
    `;
    return rows[0]!;
  });

  return rowToInvite(inserted);
}

export type PendingInviteLookup =
  | { ok: true; email: string; role: Role }
  | { ok: false; code: string; status: number; message: string };

/**
 * Read-only check used by GET /api/auth/accept-invite to render the form.
 * Never mutates. Returns a discriminated result — no throw for the expected
 * "bad token" cases.
 */
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

  const sql = getDbClient();
  const rows = await sql<
    Pick<InviteRow, "email" | "role" | "expires_at" | "used_at">[]
  >`
    SELECT email, role, expires_at, used_at
    FROM invites WHERE token = ${value} LIMIT 1
  `;
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

/**
 * Consume an invite: create the `users` row with the role stored on the invite
 * (never from client input), scrypt-hash the password, and stamp `used_at`.
 * Atomic — the invite row is locked FOR UPDATE inside the transaction, so a
 * token can be redeemed exactly once even under concurrent requests.
 *
 * Throws InviteError: INVITE_INVALID / INVITE_USED / INVITE_EXPIRED / USER_EXISTS.
 */
export async function acceptInvite(input: {
  token: string;
  password: string;
}): Promise<AcceptedInvite> {
  const token = (input.token ?? "").trim();
  if (!token) {
    throw inviteError("INVITE_INVALID", 400, "This invite link is missing its token.");
  }

  // Hash outside the transaction so the row lock is held for as short as possible.
  const passwordHash = await hashPassword(input.password);
  const sql = getDbClient();

  return sql.begin(async (tx) => {
    const rows = await tx<
      Pick<InviteRow, "id" | "email" | "role" | "expires_at" | "used_at">[]
    >`
      SELECT id, email, role, expires_at, used_at
      FROM invites WHERE token = ${token} FOR UPDATE
    `;
    const invite = rows[0];
    if (!invite) {
      throw inviteError("INVITE_INVALID", 404, "This invite link is not valid.");
    }
    if (invite.used_at) {
      throw inviteError(
        "INVITE_USED",
        410,
        "This invite link has already been used."
      );
    }
    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      throw inviteError(
        "INVITE_EXPIRED",
        410,
        "This invite link has expired. Ask a super admin for a new one."
      );
    }
    const role = isRole(invite.role) ? (invite.role as Role) : null;
    if (!role || role === "viewer") {
      throw inviteError(
        "INVITE_INVALID",
        400,
        "This invite is misconfigured. Ask a super admin for a new one."
      );
    }

    const email = String(invite.email ?? "").trim().toLowerCase();
    const existing = await tx<{ id: string }[]>`
      SELECT id FROM users WHERE LOWER(email) = ${email} LIMIT 1
    `;
    if (existing[0]) {
      throw inviteError(
        "USER_EXISTS",
        409,
        "An account with this email already exists. Try signing in instead."
      );
    }

    const userRows = await tx<{ id: string; email: string; role: string }[]>`
      INSERT INTO users (email, password_hash, role, active)
      VALUES (${email}, ${passwordHash}, ${role}, TRUE)
      RETURNING id, email, role
    `;
    const created = userRows[0]!;

    await tx`UPDATE invites SET used_at = NOW() WHERE id = ${invite.id}`;

    return {
      user: {
        id: String(created.id),
        email: String(created.email ?? email),
        role: isRole(created.role) ? (created.role as Role) : role,
      },
    };
  });
}

export type InviteListEntry = InviteRecord & {
  status: "pending" | "used" | "expired";
};

/** Recent invites (super_admin only). Helps verify state during testing. */
export async function listRecentInvites(limit = 50): Promise<InviteListEntry[]> {
  const capped = Math.min(Math.max(1, Math.floor(limit) || 50), 200);
  const sql = getDbClient();
  const rows = await sql<InviteRow[]>`
    SELECT id, email, role, token, expires_at, used_at, created_by, created_at
    FROM invites
    ORDER BY created_at DESC
    LIMIT ${capped}
  `;
  const now = Date.now();
  return rows.map((row: InviteRow) => {
    const record = rowToInvite(row);
    const status: InviteListEntry["status"] = record.usedAt
      ? "used"
      : new Date(record.expiresAt).getTime() <= now
        ? "expired"
        : "pending";
    return { ...record, status };
  });
}
