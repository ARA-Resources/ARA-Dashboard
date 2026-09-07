/**
 * Role model — mirror of src/lib/auth/roles.ts (Next.js side).
 * viewer < editor < admin < super_admin. No "operator".
 */
export const ROLES = ["viewer", "editor", "admin", "super_admin"] as const;

export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  super_admin: 4,
};

export function isRole(value: unknown): value is Role {
  return (
    typeof value === "string" && (ROLES as readonly string[]).includes(value)
  );
}

export function roleMeets(role: Role, required: Role): boolean {
  return RANK[role] >= RANK[required];
}

export const LEAST_PRIVILEGED_ROLE: Role = "viewer";
