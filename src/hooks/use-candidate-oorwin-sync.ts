"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  candidateMasterSchemaQueryKey,
  candidateSyncHistoryQueryKey,
} from "@/hooks/use-candidate-master-sheet";

export type CandidateSyncRunResultStatus = "success" | "partial" | "failed";

export interface CandidateSyncRunResult {
  ok: boolean;
  result: CandidateSyncRunResultStatus;
  syncId: number | null;
  startedAt: string;
  finishedAt: string;
  sourceFilename: string;
  triggeredBy: string;
  counts: {
    rowsInSheet: number;
    inserted: number;
    updated: number;
    unchanged: number;
    quarantined: number;
    skippedBlankCid: number;
    reviewFlags: number;
  };
  failureReason: string | null;
}

interface UploadErrorResponse {
  ok: false;
  error: string;
}

export const CANDIDATE_OORWIN_ACCEPTED_EXTENSIONS = [".xls", ".xlsx", ".xlsm"];

export function isAcceptedCandidateOorwinFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return CANDIDATE_OORWIN_ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function runCandidateOorwinSync(file: File): Promise<CandidateSyncRunResult> {
  const formData = new FormData();
  formData.set("file", file);
  const res = await fetch("/api/dataset/candidate/oorwin-sync", {
    method: "POST",
    body: formData,
  });
  const payload = (await res.json().catch(() => null)) as
    | CandidateSyncRunResult
    | UploadErrorResponse
    | null;
  if (!res.ok || !payload || !("counts" in payload)) {
    throw new Error(
      (payload as UploadErrorResponse | null)?.error ?? `Upload failed (HTTP ${res.status}).`
    );
  }
  return payload;
}

/** Uploads an Oorwin export and runs the candidate_master sync (C7/C8), then
 * refreshes the Master Sheet's cached data/schema so the table reflects the
 * run without requiring a manual Refresh click. */
export function useCandidateOorwinSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: runCandidateOorwinSync,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: candidateMasterSchemaQueryKey() });
      void queryClient.invalidateQueries({ queryKey: ["candidate-master-sheet"] });
      void queryClient.invalidateQueries({ queryKey: candidateSyncHistoryQueryKey() });
    },
  });
}
