"use client";

import { useMemo } from "react";
import { SIDEBAR_SECTIONS, type WorkspaceId } from "@/constants/navigation";
import { roleMeets, type Role } from "@/lib/auth/roles";
import { useCurrentUser } from "@/hooks/use-current-user";

/**
 * Minimum role required to SEE a nav section. UI convenience only — the real
 * enforcement is proxy.ts + the DAL (Phase 2). A user who forces the URL still
 * gets bounced server-side.
 *
 * `/settings` stays visible to everyone: it hosts universal account settings
 * (change password, profile). Admin-only cards inside it are gated separately.
 */
const SECTION_MIN_ROLE: Partial<Record<WorkspaceId, Role>> = {
  dataset: "editor",
  admin: "admin",
};

export function isSectionVisibleForRole(
  sectionId: WorkspaceId,
  role: Role
): boolean {
  const min = SECTION_MIN_ROLE[sectionId];
  return !min || roleMeets(role, min);
}

/** SIDEBAR_SECTIONS filtered to what the current user's role may see. */
export function useVisibleNavSections() {
  const { role, isLoading } = useCurrentUser();
  const sections = useMemo(
    () =>
      SIDEBAR_SECTIONS.filter((section) =>
        isSectionVisibleForRole(section.id, role)
      ),
    [role]
  );
  return { sections, role, isLoading };
}
