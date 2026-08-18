import type { Metadata } from "next";
import { PageTransition } from "@/animations/page-transition";
import { SyncHistoryPage } from "@/components/dataset/sync-history-page";

export const metadata: Metadata = {
  title: "Sync History",
};

export default function DatasetSyncHistoryRoute() {
  return (
    <PageTransition>
      <SyncHistoryPage />
    </PageTransition>
  );
}
