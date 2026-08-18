import type { Metadata } from "next";
import { Suspense } from "react";
import { PageTransition } from "@/animations/page-transition";
import { DatasetManager } from "@/components/dataset/dataset-manager";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = {
  title: "Lateral Dataset",
};

export default function LateralDatasetPage() {
  return (
    <PageTransition>
      <Suspense
        fallback={
          <div className="space-y-4">
            <Skeleton className="h-10 w-64 rounded-xl" />
            <Skeleton className="h-40 w-full rounded-2xl" />
            <Skeleton className="h-64 w-full rounded-2xl" />
          </div>
        }
      >
        <DatasetManager />
      </Suspense>
    </PageTransition>
  );
}
