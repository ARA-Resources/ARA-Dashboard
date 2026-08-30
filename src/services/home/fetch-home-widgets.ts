/**
 * Home dashboard widgets data source.
 * Same-origin /api/home/widgets → Node via Stage 10 rewrite when configured.
 */
import type { HomeDashboardWidgetsData } from "@/types/home-widgets";
import { apiFetch } from "@/lib/api/client";

async function fetchLiveHomeDashboardWidgets(): Promise<HomeDashboardWidgetsData> {
  const response = await apiFetch("/api/home/widgets", {
    method: "GET",
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(payload?.error ?? "Failed to load home dashboard widgets");
  }

  return response.json() as Promise<HomeDashboardWidgetsData>;
}

export async function fetchHomeDashboardWidgets(): Promise<HomeDashboardWidgetsData> {
  return fetchLiveHomeDashboardWidgets();
}

export const HOME_WIDGETS_QUERY_KEY = ["home-dashboard-widgets"] as const;
