import { create } from "zustand";
import type { BusinessUnitId } from "@/types/business-unit";
import type { OpeningsFilters, SortDirection } from "@/types/filters";
import type { DynamicFilterSchema } from "@/services/excel/discover-filters";
import {
  cloneOpeningsFilters,
  createBaseOpeningsFilters,
  createEmptyOpeningsFilters,
  openingsFiltersEqual,
  resolveDefaultsFromSchema,
  DEFAULT_FILTER_CONFIG,
} from "@/constants/default-filters";

interface DashboardFilterState {
  /** Resolved defaults per BU (from Excel schema) — not mutated by user edits */
  resolvedDefaultsByUnit: Partial<Record<BusinessUnitId, OpeningsFilters>>;
  /** User-selected filters per BU */
  userFiltersByUnit: Partial<Record<BusinessUnitId, OpeningsFilters>>;
  /** Track whether user customized after hydrate */
  customizedByUnit: Partial<Record<BusinessUnitId, boolean>>;

  ensureUserFilters: (businessUnitId: BusinessUnitId) => OpeningsFilters;
  getUserFilters: (businessUnitId: BusinessUnitId) => OpeningsFilters;
  getDefaultFilters: (businessUnitId: BusinessUnitId) => OpeningsFilters;
  isUsingDefaults: (businessUnitId: BusinessUnitId) => boolean;

  hydrateFromSchema: (
    businessUnitId: BusinessUnitId,
    schema: DynamicFilterSchema
  ) => void;
  syncSortFromHeaders: (
    businessUnitId: BusinessUnitId,
    headers: string[]
  ) => void;

  setColumnFilterValues: (
    businessUnitId: BusinessUnitId,
    column: string,
    values: string[]
  ) => void;
  toggleColumnFilterValue: (
    businessUnitId: BusinessUnitId,
    column: string,
    value: string
  ) => void;
  clearColumnFilter: (businessUnitId: BusinessUnitId, column: string) => void;
  setSortBy: (businessUnitId: BusinessUnitId, sortBy: string | null) => void;
  setSortDirection: (
    businessUnitId: BusinessUnitId,
    sortDirection: SortDirection
  ) => void;
  setTopN: (businessUnitId: BusinessUnitId, topN: number | null) => void;
  resetToDefaults: (businessUnitId: BusinessUnitId) => void;
  clearFilters: (businessUnitId: BusinessUnitId) => void;
}

function writeFilters(
  state: DashboardFilterState,
  businessUnitId: BusinessUnitId,
  updater: (current: OpeningsFilters) => OpeningsFilters,
  markCustomized = true
) {
  const current =
    state.userFiltersByUnit[businessUnitId] ??
    state.resolvedDefaultsByUnit[businessUnitId] ??
    createBaseOpeningsFilters(businessUnitId);
  return {
    userFiltersByUnit: {
      ...state.userFiltersByUnit,
      [businessUnitId]: updater(cloneOpeningsFilters(current)),
    },
    customizedByUnit: markCustomized
      ? { ...state.customizedByUnit, [businessUnitId]: true }
      : state.customizedByUnit,
  };
}

export const useDashboardFilterStore = create<DashboardFilterState>(
  (set, get) => ({
    resolvedDefaultsByUnit: {},
    userFiltersByUnit: {},
    customizedByUnit: {},

    ensureUserFilters: (businessUnitId) => {
      const existing = get().userFiltersByUnit[businessUnitId];
      if (existing) return existing;
      const defaults =
        get().resolvedDefaultsByUnit[businessUnitId] ??
        createBaseOpeningsFilters(businessUnitId);
      set((state) => ({
        userFiltersByUnit: {
          ...state.userFiltersByUnit,
          [businessUnitId]: cloneOpeningsFilters(defaults),
        },
      }));
      return defaults;
    },

    getUserFilters: (businessUnitId) => {
      return (
        get().userFiltersByUnit[businessUnitId] ??
        get().resolvedDefaultsByUnit[businessUnitId] ??
        createBaseOpeningsFilters(businessUnitId)
      );
    },

    getDefaultFilters: (businessUnitId) => {
      return (
        get().resolvedDefaultsByUnit[businessUnitId] ??
        createBaseOpeningsFilters(businessUnitId)
      );
    },

    isUsingDefaults: (businessUnitId) => {
      const current = get().getUserFilters(businessUnitId);
      const defaults = get().getDefaultFilters(businessUnitId);
      return openingsFiltersEqual(current, defaults);
    },

    hydrateFromSchema: (businessUnitId, schema) => {
      const resolved = resolveDefaultsFromSchema(businessUnitId, schema);
      const wasCustomized = get().customizedByUnit[businessUnitId] === true;

      set((state) => {
        const nextDefaults = {
          ...state.resolvedDefaultsByUnit,
          [businessUnitId]: resolved,
        };
        const nextUser = { ...state.userFiltersByUnit };
        if (!wasCustomized) {
          nextUser[businessUnitId] = cloneOpeningsFilters(resolved);
        } else if (!nextUser[businessUnitId]) {
          nextUser[businessUnitId] = cloneOpeningsFilters(resolved);
        }
        return {
          resolvedDefaultsByUnit: nextDefaults,
          userFiltersByUnit: nextUser,
        };
      });
    },

    syncSortFromHeaders: (businessUnitId, headers) => {
      const config = DEFAULT_FILTER_CONFIG[businessUnitId];
      let sortBy: string | null = null;
      for (const pattern of config.sortByPatterns) {
        const hit = headers.find((header) => pattern.test(header));
        if (hit) {
          sortBy = hit;
          break;
        }
      }
      if (!sortBy) return;

      set((state) => {
        const defaults = state.resolvedDefaultsByUnit[businessUnitId];
        const user = state.userFiltersByUnit[businessUnitId];
        const customized = state.customizedByUnit[businessUnitId] === true;

        const nextDefaults = defaults
          ? {
              ...state.resolvedDefaultsByUnit,
              [businessUnitId]: { ...defaults, sortBy },
            }
          : state.resolvedDefaultsByUnit;

        if (!customized && user) {
          return {
            resolvedDefaultsByUnit: nextDefaults,
            userFiltersByUnit: {
              ...state.userFiltersByUnit,
              [businessUnitId]: { ...user, sortBy },
            },
          };
        }

        return { resolvedDefaultsByUnit: nextDefaults };
      });
    },

    setColumnFilterValues: (businessUnitId, column, values) =>
      set((state) =>
        writeFilters(state, businessUnitId, (current) => ({
          ...current,
          columnFilters: {
            ...current.columnFilters,
            [column]: values,
          },
        }))
      ),

    toggleColumnFilterValue: (businessUnitId, column, value) =>
      set((state) =>
        writeFilters(state, businessUnitId, (current) => {
          const existing = current.columnFilters[column] ?? [];
          const next = existing.includes(value)
            ? existing.filter((item) => item !== value)
            : [...existing, value];
          return {
            ...current,
            columnFilters: {
              ...current.columnFilters,
              [column]: next,
            },
          };
        })
      ),

    clearColumnFilter: (businessUnitId, column) =>
      set((state) =>
        writeFilters(state, businessUnitId, (current) => {
          const next = { ...current.columnFilters };
          delete next[column];
          return { ...current, columnFilters: next };
        })
      ),

    setSortBy: (businessUnitId, sortBy) =>
      set((state) =>
        writeFilters(state, businessUnitId, (current) => ({
          ...current,
          sortBy,
        }))
      ),

    setSortDirection: (businessUnitId, sortDirection) =>
      set((state) =>
        writeFilters(state, businessUnitId, (current) => ({
          ...current,
          sortDirection,
        }))
      ),

    setTopN: (businessUnitId, topN) =>
      set((state) =>
        writeFilters(state, businessUnitId, (current) => ({
          ...current,
          topN,
        }))
      ),

    resetToDefaults: (businessUnitId) =>
      set((state) => {
        const defaults =
          state.resolvedDefaultsByUnit[businessUnitId] ??
          createBaseOpeningsFilters(businessUnitId);
        return {
          userFiltersByUnit: {
            ...state.userFiltersByUnit,
            [businessUnitId]: cloneOpeningsFilters(defaults),
          },
          customizedByUnit: {
            ...state.customizedByUnit,
            [businessUnitId]: false,
          },
        };
      }),

    clearFilters: (businessUnitId) =>
      set((state) => ({
        userFiltersByUnit: {
          ...state.userFiltersByUnit,
          [businessUnitId]: createEmptyOpeningsFilters(),
        },
        customizedByUnit: {
          ...state.customizedByUnit,
          [businessUnitId]: true,
        },
      })),
  })
);
