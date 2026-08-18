import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  getWorkspaceDefaultHref,
  resolveCompanySlugFromPathname,
  resolveDatasetGroupIdFromPathname,
  resolveModuleSlugFromPathname,
  resolveWorkspaceFromPathname,
  type WorkspaceId,
} from "@/constants/navigation";
import {
  DEFAULT_COMPANY_ID,
  getCompanyBySlug,
  getCompanyModule,
  getDefaultCompany,
} from "@/constants/companies";

/** Top-level expandable sidebar sections (accordion peers) */
const TREE_SECTIONS = ["company", "candidate", "dataset"] as const;

interface NavigationState {
  workspace: WorkspaceId;
  activeCompanyId: string;
  expandedSectionIds: string[];
  expandedCompanyIds: string[];
  expandedModuleIds: string[];
  setWorkspace: (workspace: WorkspaceId) => void;
  setActiveCompanyId: (companyId: string) => void;
  toggleSectionExpanded: (sectionId: string) => void;
  toggleCompanyExpanded: (companyId: string) => void;
  toggleModuleExpanded: (moduleId: string) => void;
  expandForWorkspace: (workspace: WorkspaceId, companyId?: string) => void;
  /**
   * Activate a top-level workspace (Company / Candidate / Admin / Settings / Home).
   * Used by both Profile dropdown and Sidebar for sync.
   */
  activateWorkspace: (workspace: WorkspaceId) => {
    href: string;
    action: "navigate" | "logout";
  };
  syncFromPathname: (pathname: string) => void;
}

function isTreeSection(id: string) {
  return (TREE_SECTIONS as readonly string[]).includes(id);
}

/** Open exactly one top-level tree section; collapse siblings */
function exclusiveSection(sectionId: string | null) {
  return sectionId && isTreeSection(sectionId) ? [sectionId] : [];
}

/** Open exactly one company under Company */
function exclusiveCompany(companyId: string | null) {
  return companyId ? [companyId] : [];
}

function exclusiveModule(moduleId: string | null) {
  return moduleId ? [moduleId] : [];
}

export const useNavigationStore = create<NavigationState>()(
  persist(
    (set, get) => ({
      workspace: "home",
      activeCompanyId: DEFAULT_COMPANY_ID,
      expandedSectionIds: [],
      expandedCompanyIds: [],
      expandedModuleIds: [],

      setWorkspace: (workspace) => set({ workspace }),

      setActiveCompanyId: (activeCompanyId) => set({ activeCompanyId }),

      toggleSectionExpanded: (sectionId) =>
        set((state) => {
          const isOpen = state.expandedSectionIds.includes(sectionId);

          if (isOpen) {
            return {
              expandedSectionIds: [],
              expandedCompanyIds:
                sectionId === "company" ? [] : state.expandedCompanyIds,
              expandedModuleIds:
                sectionId === "company" ? [] : state.expandedModuleIds,
            };
          }

          return {
            expandedSectionIds: exclusiveSection(sectionId),
            expandedCompanyIds: [],
            expandedModuleIds: [],
          };
        }),

      toggleCompanyExpanded: (companyId) =>
        set((state) => {
          const isOpen = state.expandedCompanyIds.includes(companyId);
          return {
            expandedSectionIds: exclusiveSection("company"),
            expandedCompanyIds: isOpen ? [] : exclusiveCompany(companyId),
            expandedModuleIds: isOpen ? [] : state.expandedModuleIds,
          };
        }),

      toggleModuleExpanded: (moduleId) =>
        set((state) => {
          const isOpen = state.expandedModuleIds.includes(moduleId);
          const sectionId =
            moduleId === "common-connections" ||
            moduleId === "datasets" ||
            moduleId.startsWith("dataset:")
              ? "dataset"
              : state.workspace === "dataset"
                ? "dataset"
                : "company";
          return {
            expandedSectionIds: exclusiveSection(sectionId),
            expandedModuleIds: isOpen ? [] : exclusiveModule(moduleId),
          };
        }),

      expandForWorkspace: (workspace, companyId) =>
        set((state) => {
          if (
            workspace === "home" ||
            workspace === "admin" ||
            workspace === "settings" ||
            workspace === "logout"
          ) {
            return {
              workspace,
              expandedSectionIds: [],
              expandedCompanyIds: [],
              expandedModuleIds: [],
            };
          }

          if (workspace === "dataset") {
            const keepModules =
              state.expandedModuleIds.length > 0
                ? state.expandedModuleIds
                : exclusiveModule("datasets");
            return {
              workspace: "dataset",
              expandedSectionIds: exclusiveSection("dataset"),
              expandedCompanyIds: [],
              expandedModuleIds: keepModules,
            };
          }

          if (workspace === "company") {
            return {
              workspace: "company",
              activeCompanyId: companyId ?? state.activeCompanyId,
              expandedSectionIds: exclusiveSection("company"),
              // Only expand a company when it was explicitly selected.
              expandedCompanyIds: companyId ? exclusiveCompany(companyId) : [],
              expandedModuleIds: companyId ? state.expandedModuleIds : [],
            };
          }

          if (workspace === "candidate") {
            return {
              workspace: "candidate",
              expandedSectionIds: exclusiveSection("candidate"),
              expandedCompanyIds: [],
              expandedModuleIds: [],
            };
          }

          return { workspace };
        }),

      activateWorkspace: (workspace) => {
        if (workspace === "logout") {
          get().expandForWorkspace("logout");
          return { href: "/logout", action: "logout" as const };
        }

        if (
          workspace === "home" ||
          workspace === "admin" ||
          workspace === "settings"
        ) {
          get().expandForWorkspace(workspace);
          return {
            href: getWorkspaceDefaultHref(workspace),
            action: "navigate" as const,
          };
        }

        if (workspace === "dataset") {
          get().expandForWorkspace("dataset");
          return {
            href: getWorkspaceDefaultHref("dataset"),
            action: "navigate" as const,
          };
        }

        const defaultCompany = getDefaultCompany();
        const companyId =
          workspace === "company"
            ? (get().activeCompanyId ||
                defaultCompany?.id ||
                DEFAULT_COMPANY_ID)
            : undefined;

        if (workspace === "company") {
          set({
            workspace: "company",
            expandedSectionIds: exclusiveSection("company"),
            expandedCompanyIds: [],
            expandedModuleIds: [],
            activeCompanyId: companyId ?? get().activeCompanyId,
          });
          return {
            href: "/company",
            action: "navigate" as const,
          };
        }

        get().expandForWorkspace("candidate");
        return {
          href: getWorkspaceDefaultHref("candidate"),
          action: "navigate" as const,
        };
      },

      syncFromPathname: (pathname) => {
        const workspace = resolveWorkspaceFromPathname(pathname);
        const companySlug = resolveCompanySlugFromPathname(pathname);
        const moduleSlug = resolveModuleSlugFromPathname(pathname);
        const company = companySlug ? getCompanyBySlug(companySlug) : null;
        const moduleConfig =
          companySlug && moduleSlug
            ? getCompanyModule(companySlug, moduleSlug)
            : null;
        const moduleHasChildren = Boolean(moduleConfig?.children?.length);

        set((state) => {
          if (
            workspace === "home" ||
            workspace === "admin" ||
            workspace === "settings" ||
            workspace === "logout"
          ) {
            return {
              workspace,
              expandedSectionIds: [],
              expandedCompanyIds: [],
              expandedModuleIds: [],
            };
          }

          if (workspace === "dataset") {
            const datasetGroup = resolveDatasetGroupIdFromPathname(pathname);
            return {
              workspace: "dataset",
              expandedSectionIds: exclusiveSection("dataset"),
              expandedCompanyIds: [],
              expandedModuleIds: datasetGroup
                ? exclusiveModule(datasetGroup)
                : [],
            };
          }

          if (workspace === "company") {
            return {
              workspace: "company",
              activeCompanyId: company?.id ?? state.activeCompanyId,
              expandedSectionIds: exclusiveSection("company"),
              expandedCompanyIds: exclusiveCompany(
                company?.id ?? state.activeCompanyId
              ),
              expandedModuleIds: moduleHasChildren
                ? exclusiveModule(moduleSlug)
                : [],
            };
          }

          if (workspace === "candidate") {
            return {
              workspace: "candidate",
              expandedSectionIds: exclusiveSection("candidate"),
              expandedCompanyIds: [],
              expandedModuleIds: [],
            };
          }

          return { workspace };
        });
      },
    }),
    {
      name: "ara-navigation",
      partialize: (state) => ({
        workspace: state.workspace,
        activeCompanyId: state.activeCompanyId,
        expandedSectionIds: state.expandedSectionIds,
        expandedCompanyIds: state.expandedCompanyIds,
        expandedModuleIds: state.expandedModuleIds,
      }),
      merge: (persisted, current) => {
        const stored =
          persisted && typeof persisted === "object"
            ? (persisted as Partial<NavigationState>)
            : {};

        return {
          ...current,
          ...stored,
          // Harden against older localStorage snapshots missing new fields
          expandedSectionIds: Array.isArray(stored.expandedSectionIds)
            ? stored.expandedSectionIds
            : current.expandedSectionIds,
          expandedCompanyIds: Array.isArray(stored.expandedCompanyIds)
            ? stored.expandedCompanyIds
            : current.expandedCompanyIds,
          expandedModuleIds: Array.isArray(stored.expandedModuleIds)
            ? stored.expandedModuleIds
            : current.expandedModuleIds,
          activeCompanyId: stored.activeCompanyId ?? current.activeCompanyId,
          workspace: stored.workspace ?? current.workspace,
        };
      },
    }
  )
);
