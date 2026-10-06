"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  candidateMasterSchemaQueryKey,
  candidateSyncHistoryQueryKey,
} from "@/hooks/use-candidate-master-sheet";

export type CandidateAccentureSyncRunResultStatus = "success" | "partial" | "failed";

export interface CandidateAccentureSyncRunResult {
  ok: boolean;
  result: CandidateAccentureSyncRunResultStatus;
  dryRun: boolean;
  syncId: number | null;
  startedAt: string;
  finishedAt: string;
  sourceFilename: string;
  triggeredBy: string;
  counts: {
    rowsInSheet: number;
    matchedCidCount: number;
    matchedRowCount: number;
    insertedCount: number;
    skippedBlankCidCount: number;
    invalidCidCount: number;
    reviewFlagCount: number;
    fieldChangeCounts: {
      email: number;
      job_management_level: number;
      accenture_candidate_stage: number;
      current_cid_source: number;
      application_completion_status: number;
    };
    levelFormatOnlyNoOpCount: number;
    nameMismatchNotesCount: number;
    blankCellsKeptCount: number;
    newlyLockedCount: { email: number; job_management_level: number };
  };
  failureReason: string | null;
}

interface UploadErrorResponse {
  ok: false;
  error: string;
}

export const CANDIDATE_ACCENTURE_ACCEPTED_EXTENSIONS = [".xlsx"];

export function isAcceptedCandidateAccentureFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return CANDIDATE_ACCENTURE_ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function runCandidateAccentureSync(file: File): Promise<CandidateAccentureSyncRunResult> {
  const formData = new FormData();
  formData.set("file", file);
  const res = await fetch("/api/dataset/candidate/accenture-sync", {
    method: "POST",
    body: formData,
  });
  const payload = (await res.json().catch(() => null)) as
    | CandidateAccentureSyncRunResult
    | UploadErrorResponse
    | null;
  if (!res.ok || !payload || !("counts" in payload)) {
    throw new Error(
      (payload as UploadErrorResponse | null)?.error ?? `Upload failed (HTTP ${res.status}).`
    );
  }
  return payload;
}

/** Uploads an Accenture Final Report export and runs the candidate_master Accenture sync, then
 * refreshes the Master Sheet's cached data/schema so the table reflects the run without
 * requiring a manual Refresh click — same invalidation set as useCandidateOorwinSync. */
export function useCandidateAccentureSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: runCandidateAccentureSync,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: candidateMasterSchemaQueryKey() });
      void queryClient.invalidateQueries({ queryKey: ["candidate-master-sheet"] });
      void queryClient.invalidateQueries({ queryKey: candidateSyncHistoryQueryKey() });
    },
  });
}
