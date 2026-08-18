"use client";

import { useQuery } from "@tanstack/react-query";
import type { SkillClustersResult } from "@/types/skill-clusters";

export const SKILL_CLUSTERS_QUERY_KEY = ["excel", "skill-clusters"] as const;

async function fetchSkillClusters(options?: {
  refresh?: boolean;
  primarySkill?: string;
  limitGroups?: number;
}): Promise<SkillClustersResult> {
  const params = new URLSearchParams();
  if (options?.refresh) params.set("refresh", "1");
  if (options?.primarySkill) params.set("primarySkill", options.primarySkill);
  if (options?.limitGroups) {
    params.set("limitGroups", String(options.limitGroups));
  }

  const query = params.toString();
  const response = await fetch(
    `/api/excel/lateral/skill-clusters${query ? `?${query}` : ""}`
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(payload?.error ?? "Failed to load skill clusters");
  }
  return response.json() as Promise<SkillClustersResult>;
}

export function useSkillClusters(options?: {
  refresh?: boolean;
  primarySkill?: string;
  limitGroups?: number;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: [
      ...SKILL_CLUSTERS_QUERY_KEY,
      options?.primarySkill ?? null,
      options?.limitGroups ?? null,
      options?.refresh ?? false,
    ],
    queryFn: () =>
      fetchSkillClusters({
        refresh: options?.refresh,
        primarySkill: options?.primarySkill,
        limitGroups: options?.limitGroups,
      }),
    enabled: options?.enabled ?? true,
    staleTime: 15 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
