import type { Metadata } from "next";
import { PageTransition } from "@/animations/page-transition";
import { ExecutiveDatasetManagerPage } from "@/components/dataset/executive-dataset-manager-page";

export const metadata: Metadata = {
  title: "Executive Dataset",
};

export default function ExecutiveDatasetPage() {
  return (
    <PageTransition>
      <ExecutiveDatasetManagerPage />
    </PageTransition>
  );
}
