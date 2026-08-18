"use client";

import { useQuery } from "@tanstack/react-query";
import {
  fetchHomeDashboardWidgets,
  HOME_WIDGETS_QUERY_KEY,
} from "@/services/home/fetch-home-widgets";

export function useHomeWidgets() {
  return useQuery({
    queryKey: HOME_WIDGETS_QUERY_KEY,
    queryFn: fetchHomeDashboardWidgets,
    staleTime: 120_000,
    gcTime: 10 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
