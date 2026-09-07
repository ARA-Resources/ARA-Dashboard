/**
 * Roles a super_admin may invite or assign to another user.
 *
 * `viewer` is deliberately excluded — viewer accounts are created ONLY through
 * public signup (see /api/auth/signup + the invite rule). Same list drives the
 * invite role picker and the change-role dropdown.
 *
 * Pure / isomorphic — safe to import from client components.
 */
import type { Role } from "@/lib/auth/roles";

export const ASSIGNABLE_ROLES = [
  "editor",
  "admin",
  "super_admin",
] as const satisfies readonly Role[];

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export function isAssignableRole(value: unknown): value is AssignableRole {
  return (
    typeof value === "string" &&
    (ASSIGNABLE_ROLES as readonly string[]).includes(value)
  );
}
