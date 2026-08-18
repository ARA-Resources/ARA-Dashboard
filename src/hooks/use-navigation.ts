"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useNavigationStore } from "@/stores/navigation-store";
import type { WorkspaceId } from "@/constants/navigation";

export function useNavigation() {
  const router = useRouter();
  const workspace = useNavigationStore((s) => s.workspace);
  const activeCompanyId = useNavigationStore((s) => s.activeCompanyId);
  const expandedSectionIds = useNavigationStore((s) => s.expandedSectionIds);
  const expandedCompanyIds = useNavigationStore((s) => s.expandedCompanyIds);
  const expandedModuleIds = useNavigationStore((s) => s.expandedModuleIds);
  const activateWorkspace = useNavigationStore((s) => s.activateWorkspace);
  const expandForWorkspace = useNavigationStore((s) => s.expandForWorkspace);
  const toggleSectionExpanded = useNavigationStore(
    (s) => s.toggleSectionExpanded
  );
  const toggleCompanyExpanded = useNavigationStore(
    (s) => s.toggleCompanyExpanded
  );
  const toggleModuleExpanded = useNavigationStore(
    (s) => s.toggleModuleExpanded
  );
  const setActiveCompanyId = useNavigationStore((s) => s.setActiveCompanyId);
  const syncFromPathname = useNavigationStore((s) => s.syncFromPathname);

  const goToWorkspace = useCallback(
    (next: WorkspaceId) => {
      const result = activateWorkspace(next);
      if (result.action === "logout") {
        router.push(result.href);
        return;
      }
      router.push(result.href);
    },
    [activateWorkspace, router]
  );

  const logout = useCallback(() => {
    void fetch("/api/auth/logout", { method: "POST" })
      .catch(() => undefined)
      .finally(() => {
        router.replace("/login");
        router.refresh();
      });
  }, [router]);

  return {
    workspace,
    activeCompanyId,
    expandedSectionIds,
    expandedCompanyIds,
    expandedModuleIds,
    activateWorkspace,
    expandForWorkspace,
    toggleSectionExpanded,
    toggleCompanyExpanded,
    toggleModuleExpanded,
    setActiveCompanyId,
    syncFromPathname,
    goToWorkspace,
    logout,
  };
}
