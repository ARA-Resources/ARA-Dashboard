"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  candidateMasterSchemaQueryKey,
  candidateSyncHistoryQueryKey,
} from "@/hooks/use-candidate-master-sheet";
import type { CandidateMasterRow } from "@/services/persistence/read-candidate-master";
import type { CandidateManualFieldValues } from "@/services/candidate-processing/candidate-manual-edit";

/**
 * Candidate Master Sheet — manual Add/Modify/Delete mutations (migration
 * 021). Invalidates the same three query keys `useCandidateOorwinSync`
 * already invalidates after an Upload, so the table/schema/sync-history all
 * refresh the same way regardless of which write path touched the data.
 */

async function parseJsonResponse<T>(res: Response): Promise<T> {
  const payload = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
  if (!res.ok || !payload?.ok) {
    throw new Error(payload?.error ?? `Request failed (HTTP ${res.status}).`);
  }
  return payload;
}

export interface CandidateDuplicateCheckResult {
  ok: boolean;
  rows: CandidateMasterRow[];
}

export async function checkCandidateCidDuplicates(cid: string): Promise<CandidateMasterRow[]> {
  const res = await fetch(
    `/api/excel/candidate-master-sheet/rows?cid=${encodeURIComponent(cid)}`,
    { method: "GET", cache: "no-store" }
  );
  const payload = await parseJsonResponse<CandidateDuplicateCheckResult>(res);
  return payload.rows;
}

export interface CandidateJrLookupResult {
  ok: boolean;
  values: {
    primarySkills: string | null;
    jobManagementLevel: string | null;
    market: string | null;
    clientSpoc: string | null;
  };
  conflicts: { field: string; lateralValue: string; executiveValue: string }[];
  sources: { lateral: boolean; executive: boolean };
}

export async function scanCandidateJobRequisition(jr: string): Promise<CandidateJrLookupResult> {
  const res = await fetch(
    `/api/excel/candidate-master-sheet/jr-lookup?jr=${encodeURIComponent(jr)}`,
    { method: "GET", cache: "no-store" }
  );
  return parseJsonResponse<CandidateJrLookupResult>(res);
}

export class CandidateDuplicateCidError extends Error {
  duplicates: CandidateMasterRow[];
  constructor(duplicates: CandidateMasterRow[]) {
    super("duplicate_cid");
    this.duplicates = duplicates;
  }
}

export class CandidateStaleEditError extends Error {
  current: CandidateMasterRow;
  constructor(message: string, current: CandidateMasterRow) {
    super(message);
    this.current = current;
  }
}

export interface AddCandidateInput {
  values: Record<string, string>;
  onDuplicate?: "add" | { existingId: number };
}

async function addCandidateRow(input: AddCandidateInput) {
  const res = await fetch("/api/excel/candidate-master-sheet/rows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 409) {
    const payload = (await res.json().catch(() => null)) as
      | { error?: string; duplicates?: CandidateMasterRow[]; current?: CandidateMasterRow }
      | null;
    if (payload?.duplicates) throw new CandidateDuplicateCidError(payload.duplicates);
    if (payload?.current) {
      throw new CandidateStaleEditError(payload.error ?? "Row changed since it was loaded.", payload.current);
    }
    throw new Error(payload?.error ?? "Duplicate candidate.");
  }
  return parseJsonResponse<{ ok: boolean }>(res);
}

export function useAddCandidateRow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: addCandidateRow,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: candidateMasterSchemaQueryKey() });
      void queryClient.invalidateQueries({ queryKey: ["candidate-master-sheet"] });
      void queryClient.invalidateQueries({ queryKey: candidateSyncHistoryQueryKey() });
    },
  });
}

export interface ModifyCandidateInput {
  id: number;
  values: Record<string, string>;
  original: CandidateManualFieldValues;
}

async function modifyCandidateRow(input: ModifyCandidateInput) {
  const res = await fetch(`/api/excel/candidate-master-sheet/rows/${input.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values: input.values, original: input.original }),
  });
  if (res.status === 409) {
    const payload = (await res.json().catch(() => null)) as
      | { error?: string; current?: CandidateMasterRow }
      | null;
    throw new CandidateStaleEditError(
      payload?.error ?? "Row changed since it was loaded.",
      payload?.current as CandidateMasterRow
    );
  }
  return parseJsonResponse<{ ok: boolean }>(res);
}

export function useModifyCandidateRow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: modifyCandidateRow,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: candidateMasterSchemaQueryKey() });
      void queryClient.invalidateQueries({ queryKey: ["candidate-master-sheet"] });
      void queryClient.invalidateQueries({ queryKey: candidateSyncHistoryQueryKey() });
    },
  });
}

async function deleteCandidateRow(id: number) {
  const res = await fetch(`/api/excel/candidate-master-sheet/rows/${id}`, {
    method: "DELETE",
  });
  return parseJsonResponse<{ ok: boolean; id: number; cid: string; name: string }>(res);
}

export function useDeleteCandidateRow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteCandidateRow,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: candidateMasterSchemaQueryKey() });
      void queryClient.invalidateQueries({ queryKey: ["candidate-master-sheet"] });
      void queryClient.invalidateQueries({ queryKey: candidateSyncHistoryQueryKey() });
    },
  });
}
