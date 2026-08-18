import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AllocationRecruiterState {
  /** clusterId → recruiter name (inherited by all openings in the cluster) */
  clusterAssignments: Record<string, string>;
  /** openingId → recruiter name (manual override; wins over cluster assignment) */
  openingOverrides: Record<string, string>;
  assignClusterRecruiter: (clusterId: string, recruiter: string | null) => void;
  assignOpeningRecruiter: (openingId: string, recruiter: string | null) => void;
  clearOpeningOverride: (openingId: string) => void;
  clearAll: () => void;
}

export const useAllocationRecruiterStore = create<AllocationRecruiterState>()(
  persist(
    (set) => ({
      clusterAssignments: {},
      openingOverrides: {},
      assignClusterRecruiter: (clusterId, recruiter) =>
        set((state) => {
          const next = { ...state.clusterAssignments };
          if (!recruiter) {
            delete next[clusterId];
          } else {
            next[clusterId] = recruiter;
          }
          return { clusterAssignments: next };
        }),
      assignOpeningRecruiter: (openingId, recruiter) =>
        set((state) => {
          const next = { ...state.openingOverrides };
          if (recruiter === null) {
            delete next[openingId];
          } else {
            // Empty string = explicit unassigned override (do not inherit cluster)
            next[openingId] = recruiter;
          }
          return { openingOverrides: next };
        }),
      clearOpeningOverride: (openingId) =>
        set((state) => {
          const next = { ...state.openingOverrides };
          delete next[openingId];
          return { openingOverrides: next };
        }),
      clearAll: () => set({ clusterAssignments: {}, openingOverrides: {} }),
    }),
    { name: "ara-allocation-recruiter-assignments" }
  )
);
