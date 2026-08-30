"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  ExecutiveMasterDateFilter,
  ExecutiveMasterFilterSchema,
  ExecutiveMasterPageSize,
  ExecutiveMasterSheetPageResult,
} from "@/services/excel/executive-master-sheet";

export interface ExecutiveMasterSheetClientQuery {
  page: number;
  pageSize: ExecutiveMasterPageSize;
  columnFilters: Record<string, string[]>;
  textFilters: Record<string, string>;
  dateFilters: Record<string, ExecutiveMasterDateFilter>;
}

export function executiveMasterSchemaQueryKey() {
  return ["executive-master-sheet-schema"] as const;
}

export function executiveMasterSheetQueryKey(
  query: ExecutiveMasterSheetClientQuery
) {
  return ["executive-master-sheet", query] as const;
}

function buildParams(
  query: ExecutiveMasterSheetClientQuery,
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

export async function fetchExecutiveMasterFilterSchema(options?: {
  refresh?: boolean;
}): Promise<ExecutiveMasterFilterSchema> {
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
    `/api/excel/executive-master-sheet?${params.toString()}`,
    { method: "GET", cache: "no-store" }
  );
  const payload = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    schema?: ExecutiveMasterFilterSchema;
  } | null;
  if (!res.ok || !payload?.schema) {
    throw new Error(
      payload?.error ?? "Failed to load Executive Master Sheet filters."
    );
  }
  return payload.schema;
}

export async function fetchExecutiveMasterSheet(
  query: ExecutiveMasterSheetClientQuery,
  options?: { refresh?: boolean }
): Promise<ExecutiveMasterSheetPageResult> {
  const params = buildParams(query, { refresh: options?.refresh });
  const res = await fetch(
    `/api/excel/executive-master-sheet?${params.toString()}`,
    { method: "GET", cache: "no-store" }
  );
  const payload = (await res.json().catch(() => null)) as
    | (ExecutiveMasterSheetPageResult & { ok?: boolean; error?: string })
    | null;
  if (!res.ok || !payload?.headers) {
    throw new Error(
      payload?.error ?? "Executive Master Sheet could not be loaded."
    );
  }
  return payload;
}

export async function downloadExecutiveMasterSheetXlsx(options?: {
  refresh?: boolean;
}): Promise<void> {
  const params = new URLSearchParams();
  if (options?.refresh) params.set("refresh", "1");
  const qs = params.toString();
  const res = await fetch(
    `/api/excel/executive-master-sheet/export${qs ? `?${qs}` : ""}`,
    { method: "GET", cache: "no-store" }
  );
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      payload?.error ?? "Failed to download Executive Master Sheet Excel."
    );
  }

  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="([^"]+)"/i.exec(disposition);
  const fileName = match?.[1] ?? "Executive-Master-Sheet.xlsx";

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function useExecutiveMasterFilterSchema() {
  return useQuery({
    queryKey: executiveMasterSchemaQueryKey(),
    queryFn: () => fetchExecutiveMasterFilterSchema(),
    staleTime: 60_000,
  });
}

export function useExecutiveMasterSheet(query: ExecutiveMasterSheetClientQuery) {
  const hasActiveFilters =
    Object.values(query.columnFilters).some((v) => v.length > 0) ||
    Object.values(query.textFilters).some((v) => v.trim().length > 0) ||
    Object.values(query.dateFilters).some((v) => Boolean(v.from || v.to));

  return useQuery({
    queryKey: executiveMasterSheetQueryKey(query),
    queryFn: () => fetchExecutiveMasterSheet(query),
    staleTime: 30_000,
    placeholderData: hasActiveFilters ? undefined : (previous) => previous,
  });
}
