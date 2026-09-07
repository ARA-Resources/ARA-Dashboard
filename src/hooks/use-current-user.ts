"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/client";
import { roleMeets, type Role } from "@/lib/auth/roles";

export const CURRENT_USER_QUERY_KEY = ["current-user"] as const;

export type CurrentUser = {
  id: string;
  username: string;
  email: string;
  role: Role;
  displayName: string | null;
  avatarColor: string | null;
};

async function fetchCurrentUser(): Promise<CurrentUser | null> {
  const res = await apiFetch("/api/auth/me", { cache: "no-store" });
  if (!res.ok) return null;
  const data = (await res.json()) as Partial<CurrentUser>;
  if (!data.id || !data.role) return null;
  return {
    id: data.id,
    username: data.username ?? data.email ?? "",
    email: data.email ?? "",
    role: data.role,
    displayName: data.displayName ?? null,
    avatarColor: data.avatarColor ?? null,
  };
}

/**
 * The logged-in user, with the CURRENT role from the server (10s cache in the
 * DAL). Used for UI gating only — real enforcement is proxy.ts + the DAL.
 */
export function useCurrentUser() {
  const query = useQuery({
    queryKey: CURRENT_USER_QUERY_KEY,
    queryFn: fetchCurrentUser,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const role: Role = query.data?.role ?? "viewer";
  return {
    ...query,
    user: query.data ?? null,
    role,
    isAtLeast: (minimum: Role) => Boolean(query.data) && roleMeets(role, minimum),
    isSuperAdmin: query.data?.role === "super_admin",
  };
}
