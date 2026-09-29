"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type {
  ExecutiveMasterDateFilter,
  ExecutiveMasterPageSize,
} from "@/services/excel/executive-master-sheet";
import type {
  ExecutiveMasterSheetSchema,
  ExecutiveMasterSheetPageResult,
} from "@/services/persistence/executive-master-sheet-postgres";
import type { ExecutiveSchedulerStatus } from "@/types/executive-scheduler";

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
}): Promise<ExecutiveMasterSheetSchema> {
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
    schema?: ExecutiveMasterSheetSchema;
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

/**
 * Download Master Sheet as .xlsx, respecting the same filters currently
 * applied to the on-screen table.
 */
export async function downloadExecutiveMasterSheetXlsx(
  query: ExecutiveMasterSheetClientQuery,
  options?: { refresh?: boolean }
): Promise<void> {
  const params = buildParams(query, { refresh: options?.refresh });
  const res = await fetch(
    `/api/excel/executive-master-sheet/export?${params.toString()}`,
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
  return useQuery({
    queryKey: executiveMasterSheetQueryKey(query),
    queryFn: () => fetchExecutiveMasterSheet(query),
    staleTime: 30_000,
    // Keep the last result on screen (dimmed via isFetching) while a filter /
    // page change refetches. Header-filter dropdowns live inside <thead>, so the
    // table must NOT unmount into a skeleton on every filter change — that tears
    // down whatever dropdown the user has open. Same fix as Lateral's
    // useLateralMasterSheet; keep this in sync with it.
    placeholderData: keepPreviousData,
  });
}

export function executiveSchedulerStatusQueryKey() {
  return ["executive-scheduler-status"] as const;
}

/**
 * Same endpoint the working `/dataset/executive` "Last Run All" banner
 * already reads (`executive-scheduler-panel.tsx`) — reused here to power the
 * equivalent banner on the Master Sheet page. No new backend logic.
 */
export async function fetchExecutiveSchedulerStatus(): Promise<ExecutiveSchedulerStatus> {
  const res = await fetch("/api/dataset/executive/scheduler", {
    method: "GET",
    cache: "no-store",
  });
  const payload = (await res.json().catch(() => null)) as
    | (ExecutiveSchedulerStatus & { error?: string })
    | null;
  if (!res.ok || !payload) {
    throw new Error(payload?.error ?? "Failed to load Executive run status.");
  }
  return payload;
}

export function useExecutiveSchedulerStatus() {
  return useQuery({
    queryKey: executiveSchedulerStatusQueryKey(),
    queryFn: fetchExecutiveSchedulerStatus,
    staleTime: 30_000,
  });
}
