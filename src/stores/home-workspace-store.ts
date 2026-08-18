import { create } from "zustand";
import { persist } from "zustand/middleware";

export type HomeWorkspacePreference = "company" | "candidate";

interface HomeWorkspaceState {
  preferredWorkspace: HomeWorkspacePreference | null;
  hasHydrated: boolean;
  setPreferredWorkspace: (workspace: HomeWorkspacePreference) => void;
  setHasHydrated: (value: boolean) => void;
}

/**
 * Remembers Company vs Candidate selection for subsequent visits.
 * Kept separate from sidebar navigation state.
 */
export const useHomeWorkspaceStore = create<HomeWorkspaceState>()(
  persist(
    (set) => ({
      preferredWorkspace: null,
      hasHydrated: false,
      setPreferredWorkspace: (preferredWorkspace) => set({ preferredWorkspace }),
      setHasHydrated: (hasHydrated) => set({ hasHydrated }),
    }),
    {
      name: "ara-home-workspace",
      partialize: (state) => ({
        preferredWorkspace: state.preferredWorkspace,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);
