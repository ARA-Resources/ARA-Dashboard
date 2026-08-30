"use client";

import { useQuery } from "@tanstack/react-query";
import type { BusinessUnitId } from "@/types/business-unit";
import type { ExcelOpeningsResult } from "@/types/excel";
import type { OpeningsFilters } from "@/types/filters";
import type { DynamicFilterSchema } from "@/services/excel/discover-filters";

/** Stable query-key fragment so filter object identity cannot break cache updates */
export function openingsFiltersQueryKey(filters: OpeningsFilters) {
  return {
    columnFilters: filters.columnFilters ?? {},
    sortBy: filters.sortBy,
    sortDirection: filters.sortDirection,
    topN: filters.topN,
  };
}

export function excelOpeningsQueryKey(
  businessUnitId: BusinessUnitId,
  filters: OpeningsFilters
) {
  return ["excel-openings", businessUnitId, openingsFiltersQueryKey(filters)] as const;
}

export function excelFiltersQueryKey(businessUnitId: BusinessUnitId) {
  return ["excel-filters", businessUnitId] as const;
}

function buildFilterParams(
  filters: OpeningsFilters,
  options?: { refresh?: boolean }
) {
  const params = new URLSearchParams();
  params.set("columnFilters", JSON.stringify(filters.columnFilters ?? {}));
  params.set("sortBy", filters.sortBy ?? "");
  params.set("sortDir", filters.sortDirection);
  params.set(
    "top",
    filters.topN === null || filters.topN === undefined
      ? "all"
      : String(filters.topN)
  );
  if (options?.refresh) params.set("refresh", "1");
  return params;
}

export async function fetchTopOpenings(
  businessUnitId: BusinessUnitId,
  filters: OpeningsFilters,
  options?: { refresh?: boolean }
): Promise<ExcelOpeningsResult> {
  const params = buildFilterParams(filters, options);
  const endpoint =
    businessUnitId === "lateral"
      ? "/api/dataset/lateral/p-roles"
      : businessUnitId === "executive"
        ? "/api/excel/executive-p-dashboard"
        : `/api/excel/${businessUnitId}`;
  const response = await fetch(
    `${endpoint}?${params.toString()}`,
    { method: "GET", cache: "no-store" }
  );

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(payload?.error ?? `Failed to load ${businessUnitId} Excel`);
  }

  return response.json() as Promise<ExcelOpeningsResult>;
}

export async function fetchFilterSchema(
  businessUnitId: BusinessUnitId,
  options?: { refresh?: boolean }
): Promise<DynamicFilterSchema> {
  const params = new URLSearchParams();
  if (options?.refresh) params.set("refresh", "1");
  const suffix = params.toString() ? `?${params.toString()}` : "";

  if (businessUnitId === "executive") {
    const schemaParams = new URLSearchParams(params);
    schemaParams.set("schema", "1");
    const response = await fetch(
      `/api/excel/executive-p-dashboard?${schemaParams.toString()}`,
      { method: "GET", cache: "no-store" }
    );
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      schema?: DynamicFilterSchema;
    } | null;
    if (!response.ok || !payload?.schema) {
      throw new Error(
        payload?.error ?? "Failed to load filters for executive"
      );
    }
    return payload.schema;
  }

  const response = await fetch(`/api/excel/${businessUnitId}/filters${suffix}`, {
    method: "GET",
    cache: "no-store",
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      payload?.error ?? `Failed to load filters for ${businessUnitId}`
    );
  }

  return response.json() as Promise<DynamicFilterSchema>;
}

export function useBusinessUnitOpenings(
  businessUnitId: BusinessUnitId,
  filters: OpeningsFilters
) {
  return useQuery({
    queryKey: excelOpeningsQueryKey(businessUnitId, filters),
    queryFn: () => fetchTopOpenings(businessUnitId, filters),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useBusinessUnitFilterSchema(businessUnitId: BusinessUnitId) {
  return useQuery({
    queryKey: excelFiltersQueryKey(businessUnitId),
    queryFn: () => fetchFilterSchema(businessUnitId),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
