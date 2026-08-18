import type { Metadata } from "next";
import { PageTransition } from "@/animations/page-transition";
import { DatasetConnectionsPage } from "@/components/dataset/dataset-connections-page";

export const metadata: Metadata = {
  title: "Common Connections",
};

export default function DatasetConnectionsHubPage() {
  return (
    <PageTransition>
      <DatasetConnectionsPage view="hub" />
    </PageTransition>
  );
}
