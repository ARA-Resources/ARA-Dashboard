import type { Metadata } from "next";
import { PageTransition } from "@/animations/page-transition";
import { ExecutiveDatasetIngestionPage } from "@/components/dataset/executive-dataset-ingestion-page";

export const metadata: Metadata = {
  title: "Executive Dataset",
};

export default function ExecutiveDatasetPage() {
  return (
    <PageTransition>
      <ExecutiveDatasetIngestionPage />
    </PageTransition>
  );
}
