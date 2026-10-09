"use client";

import { useQuery } from "@tanstack/react-query";
import type { LateralSchedulerStatus } from "@/types/lateral-scheduler";

export function lateralSchedulerStatusQueryKey() {
  return ["lateral-scheduler-status"] as const;
}

/**
 * Thrown only for a non-2xx HTTP response (never for a network-level
 * failure, where `fetch()` itself rejects with a plain Error/TypeError and
 * no status) — lets the retry policy below tell "the server answered with
 * an error code" apart from "the request never completed at all".
 */
export class LateralSchedulerStatusHttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "LateralSchedulerStatusHttpError";
    this.status = status;
  }
}

/**
 * Same endpoint the Lateral dataset page's scheduler panel already reads
 * (`lateral-scheduler-panel.tsx`) — reused here only to read `gmailCheckpoint`
 * for the Master Sheet page's "Latest demand sheet" line. No new backend
 * logic; `gmailCheckpoint` was already present in this route's response.
 */
export async function fetchLateralSchedulerStatus(): Promise<LateralSchedulerStatus> {
  const res = await fetch("/api/dataset/lateral/scheduler", {
    method: "GET",
    cache: "no-store",
  });
  const payload = (await res.json().catch(() => null)) as
    | (LateralSchedulerStatus & { error?: string })
    | null;
  if (!res.ok || !payload) {
    throw new LateralSchedulerStatusHttpError(
      payload?.error ?? "Failed to load Lateral run status.",
      res.status
    );
  }
  return payload;
}

/**
 * Exported standalone so it's independently testable (see
 * scripts/verify-lateral-scheduler-status-retry.ts) without mounting a real
 * query client. A viewer-role session gets a 403 here (/api/dataset/*
 * requires editor+) — never retry that, so the new line just hides quietly
 * instead of burning requests a viewer will never pass. A genuine transient
 * failure (network error, or the server itself erroring with 5xx) still
 * gets a couple of retries like react-query's own default, just not an
 * unbounded one and never for 401/403.
 */
export function lateralSchedulerStatusRetry(
  failureCount: number,
  error: unknown
): boolean {
  const status =
    error instanceof LateralSchedulerStatusHttpError ? error.status : undefined;
  if (status === 401 || status === 403) return false;
  // A network-level failure (fetch() itself rejected) has no status — treat
  // as retryable. Any other HTTP status we got an answer for (4xx other
  // than 401/403, or a malformed-payload case) is treated as not retryable
  // either — only 5xx and "no response at all" retry.
  if (status !== undefined && status < 500) return false;
  return failureCount <= 2;
}

export function useLateralSchedulerStatus() {
  return useQuery({
    queryKey: lateralSchedulerStatusQueryKey(),
    queryFn: fetchLateralSchedulerStatus,
    staleTime: 30_000,
    retry: lateralSchedulerStatusRetry,
  });
}
