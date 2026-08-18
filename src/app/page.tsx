"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useHomeWorkspaceStore } from "@/stores/home-workspace-store";
import {
  getCandidateWorkspaceHref,
  getCompanyWorkspaceHref,
} from "@/utils/home-navigation";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * App entry: restore last workspace from localStorage, otherwise go to Home.
 */
export default function RootPage() {
  const router = useRouter();
  const preferredWorkspace = useHomeWorkspaceStore((s) => s.preferredWorkspace);
  const hasHydrated = useHomeWorkspaceStore((s) => s.hasHydrated);
  const setHasHydrated = useHomeWorkspaceStore((s) => s.setHasHydrated);

  useEffect(() => {
    // Fallback if persist rehydration already finished before mount
    const unsub = useHomeWorkspaceStore.persist.onFinishHydration(() => {
      setHasHydrated(true);
    });
    if (useHomeWorkspaceStore.persist.hasHydrated()) {
      setHasHydrated(true);
    }
    return unsub;
  }, [setHasHydrated]);

  useEffect(() => {
    if (!hasHydrated) return;

    if (preferredWorkspace === "company") {
      router.replace(getCompanyWorkspaceHref());
      return;
    }
    if (preferredWorkspace === "candidate") {
      router.replace(getCandidateWorkspaceHref());
      return;
    }
    router.replace("/home");
  }, [hasHydrated, preferredWorkspace, router]);

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-3">
        <Skeleton className="size-14 rounded-2xl" />
        <Skeleton className="h-6 w-40 rounded-lg" />
        <Skeleton className="h-4 w-56 rounded-lg" />
      </div>
    </div>
  );
}
