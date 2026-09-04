"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  LateralMasterDateFilter,
  LateralMasterFilterSchema,
  LateralMasterPageSize,
  LateralMasterSheetPageResult,
} from "@/services/excel/lateral-master-sheet";

export interface LateralMasterSheetClientQuery {
  page: number;
  pageSize: LateralMasterPageSize;
  columnFilters: Record<string, string[]>;
  textFilters: Record<string, string>;
  dateFilters: Record<string, LateralMasterDateFilter>;
}

export function lateralMasterSchemaQueryKey() {
  return ["lateral-master-sheet-schema"] as const;
}

export function lateralMasterSheetQueryKey(
  query: LateralMasterSheetClientQuery
) {
  return ["lateral-master-sheet", query] as const;
}

function buildParams(
  query: LateralMasterSheetClientQuery,
  options?: { refresh?: boolean; schema?: boolean }
) {
  const params = new URLSearchParams();
  if (options?.schema) {
    params.set("schema", "1");
  } else {
    params.set("page", String(query.page));
    params.set("pageSize", String(query.pageSize));
    params.set("columnFilters", JSON.stringify(query.columnFilters ?? {}));
    params.set("textFilters", JSON.stringify(query.textFilters ?? {}));
    params.set("dateFilters", JSON.stringify(query.dateFilters ?? {}));
  }
  if (options?.refresh) params.set("refresh", "1");
  return params;
}

export async function fetchLateralMasterFilterSchema(options?: {
  refresh?: boolean;
}): Promise<LateralMasterFilterSchema> {
  const params = buildParams(
    {
      page: 1,
      pageSize: 20,
      columnFilters: {},
      textFilters: {},
      dateFilters: {},
    },
    { schema: true, refresh: options?.refresh }
  );
  const res = await fetch(
    `/api/excel/lateral-master-sheet?${params.toString()}`,
    { method: "GET", cache: "no-store" }
  );
  const payload = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    schema?: LateralMasterFilterSchema;
  } | null;
  if (!res.ok || !payload?.schema) {
    throw new Error(payload?.error ?? "Failed to load Master Sheet filters.");
  }
  return payload.schema;
}

export async function fetchLateralMasterSheet(
  query: LateralMasterSheetClientQuery,
  options?: { refresh?: boolean }
): Promise<LateralMasterSheetPageResult> {
  const params = buildParams(query, { refresh: options?.refresh });
  const res = await fetch(
    `/api/excel/lateral-master-sheet?${params.toString()}`,
    { method: "GET", cache: "no-store" }
  );
  const payload = (await res.json().catch(() => null)) as
    | (LateralMasterSheetPageResult & { ok?: boolean; error?: string })
    | null;
  if (!res.ok || !payload?.headers) {
    throw new Error(payload?.error ?? "Failed to load Lateral Master Sheet.");
  }
  return payload;
}

/** Download full Master Sheet as .xlsx (headers + AutoFilter). */
export async function downloadLateralMasterSheetXlsx(options?: {
  refresh?: boolean;
}): Promise<void> {
  const params = new URLSearchParams();
  if (options?.refresh) params.set("refresh", "1");
  const qs = params.toString();
  const res = await fetch(
    `/api/excel/lateral-master-sheet/export${qs ? `?${qs}` : ""}`,
    { method: "GET", cache: "no-store" }
  );
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(payload?.error ?? "Failed to download Master Sheet Excel.");
  }

  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="([^"]+)"/i.exec(disposition);
  const fileName = match?.[1] ?? "Lateral-Master-Sheet.xlsx";

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function useLateralMasterFilterSchema() {
  return useQuery({
    queryKey: lateralMasterSchemaQueryKey(),
    queryFn: () => fetchLateralMasterFilterSchema(),
    staleTime: 5 * 60_000,
  });
}

export function useLateralMasterSheet(query: LateralMasterSheetClientQuery) {
  const hasActiveFilters =
    Object.values(query.columnFilters).some((v) => v.length > 0) ||
    Object.values(query.textFilters).some((v) => v.trim().length > 0) ||
    Object.values(query.dateFilters).some((v) => Boolean(v.from || v.to));

  return useQuery({
    queryKey: lateralMasterSheetQueryKey(query),
    queryFn: () => fetchLateralMasterSheet(query),
    staleTime: 60_000,
    // Keep previous page only while paging with the same filters.
    // Stale unfiltered rows make Job Description search look broken.
    placeholderData: hasActiveFilters ? undefined : (previous) => previous,
  });
}
