import { create } from "zustand";

/**
 * Filter store placeholder — wire business-unit filters in a later phase.
 */
interface FilterState {
  activeFilters: Record<string, string | string[] | null>;
  setFilter: (key: string, value: string | string[] | null) => void;
  clearFilters: () => void;
}

export const useFilterStore = create<FilterState>((set) => ({
  activeFilters: {},
  setFilter: (key, value) =>
    set((state) => ({
      activeFilters: { ...state.activeFilters, [key]: value },
    })),
  clearFilters: () => set({ activeFilters: {} }),
}));
