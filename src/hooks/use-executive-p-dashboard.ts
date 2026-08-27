"use client";

import { useQuery } from "@tanstack/react-query";
import type { ExcelOpeningsResult } from "@/types/excel";
import type { OpeningsFilters } from "@/types/filters";
import type { DynamicFilterSchema } from "@/services/excel/discover-filters";
import { openingsFiltersQueryKey } from "@/hooks/use-business-unit-openings";

export function executivePDashboardQueryKey(filters: OpeningsFilters) {
  return [
    "executive-p-dashboard",
    openingsFiltersQueryKey(filters),
  ] as const;
}

export function executivePDashboardSchemaQueryKey() {
  return ["executive-p-dashboard-schema"] as const;
}

function buildParams(
  filters: OpeningsFilters,
  options?: { refresh?: boolean; schema?: boolean }
) {
  const params = new URLSearchParams();
  if (options?.schema) {
    params.set("schema", "1");
  } else {
    params.set("columnFilters", JSON.stringify(filters.columnFilters ?? {}));
    params.set("sortBy", filters.sortBy ?? "");
    params.set("sortDir", filters.sortDirection);
    params.set(
      "top",
      filters.topN === null || filters.topN === undefined
        ? "all"
        : String(filters.topN)
    );
  }
  if (options?.refresh) params.set("refresh", "1");
  return params;
}

export async function fetchExecutivePDashboard(
  filters: OpeningsFilters,
  options?: { refresh?: boolean }
): Promise<ExcelOpeningsResult> {
  const params = buildParams(filters, options);
  const response = await fetch(
    `/api/excel/executive-p-dashboard?${params.toString()}`,
    { method: "GET", cache: "no-store" }
  );
  const payload = (await response.json().catch(() => null)) as
    | (ExcelOpeningsResult & { ok?: boolean; error?: string })
    | null;
  if (!response.ok || !payload?.headers) {
    throw new Error(payload?.error ?? "Failed to load Executive P-Dashboard.");
  }
  return payload;
}

export async function fetchExecutivePDashboardFilterSchema(options?: {
  refresh?: boolean;
}): Promise<DynamicFilterSchema> {
  const params = buildParams(
    {
      columnFilters: {},
      sortBy: null,
      sortDirection: "desc",
      topN: null,
    },
    { schema: true, refresh: options?.refresh }
  );
  const response = await fetch(
    `/api/excel/executive-p-dashboard?${params.toString()}`,
    { method: "GET", cache: "no-store" }
  );
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    schema?: DynamicFilterSchema;
  } | null;
  if (!response.ok || !payload?.schema) {
    throw new Error(
      payload?.error ?? "Failed to load Executive P-Dashboard filters."
    );
  }
  return payload.schema;
}

export function useExecutivePDashboard(filters: OpeningsFilters) {
  return useQuery({
    queryKey: executivePDashboardQueryKey(filters),
    queryFn: () => fetchExecutivePDashboard(filters),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useExecutivePDashboardFilterSchema() {
  return useQuery({
    queryKey: executivePDashboardSchemaQueryKey(),
    queryFn: () => fetchExecutivePDashboardFilterSchema(),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
