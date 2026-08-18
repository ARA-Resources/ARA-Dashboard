import type { Metadata } from "next";
import { PageTransition } from "@/animations/page-transition";
import { DatasetConnectionsPage } from "@/components/dataset/dataset-connections-page";

export const metadata: Metadata = {
  title: "Gmail Connection",
};

export default function DatasetGmailConnectionPage() {
  return (
    <PageTransition>
      <DatasetConnectionsPage view="gmail" />
    </PageTransition>
  );
}
