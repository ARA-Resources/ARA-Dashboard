/**
 * ARA Dashboard role model (Phase 2).
 *
 * Four roles, increasing privilege. The legacy "operator" role is gone — do not
 * reintroduce it anywhere in new code.
 *
 *   viewer      → Home, Demands, Candidates (read-only dashboard data)
 *   editor      → viewer + full Dataset access (Gmail OAuth, sync, config, Run All)
 *   admin       → editor + Admin & Settings sections + all features
 *                 (NO user-management ability)
 *   super_admin → admin + user management (invite / change role / deactivate)
 */
export const ROLES = ["viewer", "editor", "admin", "super_admin"] as const;

export type Role = (typeof ROLES)[number];

/** Numeric privilege rank — higher means more access. */
const RANK: Record<Role, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  super_admin: 4,
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function roleRank(role: Role): number {
  return RANK[role];
}

/**
 * Does `role` meet (>=) the `required` minimum role?
 * Used by every access check — proxy (optimistic) and DAL (authoritative).
 */
export function roleMeets(role: Role, required: Role): boolean {
  return RANK[role] >= RANK[required];
}

/**
 * The least-privileged role. Used as the fail-closed default whenever a role
 * cannot be determined (missing DB row, unparseable token, etc.).
 */
export const LEAST_PRIVILEGED_ROLE: Role = "viewer";
