import type { Metadata } from "next";
import { PageTransition } from "@/animations/page-transition";
import { DatasetPlaceholderPage } from "@/components/dataset/dataset-placeholder-page";

export const metadata: Metadata = {
  title: "Consulting Dataset",
};

export default function ConsultingDatasetPage() {
  return (
    <PageTransition>
      <DatasetPlaceholderPage datasetName="Consulting" />
    </PageTransition>
  );
}
