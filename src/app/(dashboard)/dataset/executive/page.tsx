import type { Metadata } from "next";
import { PageTransition } from "@/animations/page-transition";
import { DatasetPlaceholderPage } from "@/components/dataset/dataset-placeholder-page";

export const metadata: Metadata = {
  title: "Executive Dataset",
};

export default function ExecutiveDatasetPage() {
  return (
    <PageTransition>
      <DatasetPlaceholderPage datasetName="Executive" />
    </PageTransition>
  );
}
