"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  CandidateMasterDateFilter,
  CandidateMasterPageSize,
} from "@/services/excel/candidate-master-sheet";
import type {
  CandidateMasterSheetSchema,
  CandidateMasterSheetPageResult,
} from "@/services/persistence/candidate-master-sheet-postgres";

export interface CandidateMasterSheetClientQuery {
  page: number;
  pageSize: CandidateMasterPageSize;
  columnFilters: Record<string, string[]>;
  textFilters: Record<string, string>;
  dateFilters: Record<string, CandidateMasterDateFilter>;
}

export function candidateMasterSchemaQueryKey() {
  return ["candidate-master-sheet-schema"] as const;
}

export function candidateMasterSheetQueryKey(query: CandidateMasterSheetClientQuery) {
  return ["candidate-master-sheet", query] as const;
}

function buildParams(
  query: CandidateMasterSheetClientQuery,
  options?: { schema?: boolean }
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
  return params;
}

export async function fetchCandidateMasterFilterSchema(): Promise<CandidateMasterSheetSchema> {
  const params = buildParams(
    { page: 1, pageSize: 20, columnFilters: {}, textFilters: {}, dateFilters: {} },
    { schema: true }
  );
  const res = await fetch(`/api/excel/candidate-master-sheet?${params.toString()}`, {
    method: "GET",
    cache: "no-store",
  });
  const payload = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    schema?: CandidateMasterSheetSchema;
  } | null;
  if (!res.ok || !payload?.schema) {
    throw new Error(payload?.error ?? "Failed to load Candidate Master Sheet filters.");
  }
  return payload.schema;
}

export async function fetchCandidateMasterSheet(
  query: CandidateMasterSheetClientQuery
): Promise<CandidateMasterSheetPageResult> {
  const params = buildParams(query);
  const res = await fetch(`/api/excel/candidate-master-sheet?${params.toString()}`, {
    method: "GET",
    cache: "no-store",
  });
  const payload = (await res.json().catch(() => null)) as
    | (CandidateMasterSheetPageResult & { ok?: boolean; error?: string })
    | null;
  if (!res.ok || !payload?.headers) {
    throw new Error(payload?.error ?? "Candidate Master Sheet could not be loaded.");
  }
  return payload;
}

export function useCandidateMasterFilterSchema() {
  return useQuery({
    queryKey: candidateMasterSchemaQueryKey(),
    queryFn: () => fetchCandidateMasterFilterSchema(),
    staleTime: 60_000,
  });
}

export function useCandidateMasterSheet(query: CandidateMasterSheetClientQuery) {
  const hasActiveFilters =
    Object.values(query.columnFilters).some((v) => v.length > 0) ||
    Object.values(query.textFilters).some((v) => v.trim().length > 0) ||
    Object.values(query.dateFilters).some((v) => Boolean(v.from || v.to));

  return useQuery({
    queryKey: candidateMasterSheetQueryKey(query),
    queryFn: () => fetchCandidateMasterSheet(query),
    staleTime: 30_000,
    placeholderData: hasActiveFilters ? undefined : (previous) => previous,
  });
}
