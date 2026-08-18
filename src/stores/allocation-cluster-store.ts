import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AllocationClusterState {
  /** openingId → manually assigned clusterId */
  assignments: Record<string, string>;
  reassignOpening: (openingId: string, clusterId: string) => void;
  clearAssignment: (openingId: string) => void;
  clearAll: () => void;
}

export const useAllocationClusterStore = create<AllocationClusterState>()(
  persist(
    (set) => ({
      assignments: {},
      reassignOpening: (openingId, clusterId) =>
        set((state) => ({
          assignments: {
            ...state.assignments,
            [openingId]: clusterId,
          },
        })),
      clearAssignment: (openingId) =>
        set((state) => {
          const next = { ...state.assignments };
          delete next[openingId];
          return { assignments: next };
        }),
      clearAll: () => set({ assignments: {} }),
    }),
    { name: "ara-allocation-cluster-assignments" }
  )
);
