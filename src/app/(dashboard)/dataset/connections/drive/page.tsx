import type { Metadata } from "next";
import { PageTransition } from "@/animations/page-transition";
import { DatasetConnectionsPage } from "@/components/dataset/dataset-connections-page";

export const metadata: Metadata = {
  title: "Google Drive Connection",
};

export default function DatasetDriveConnectionPage() {
  return (
    <PageTransition>
      <DatasetConnectionsPage view="drive" />
    </PageTransition>
  );
}
