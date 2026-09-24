import type { Metadata } from "next";
import { PageTransition } from "@/animations/page-transition";
import { CandidateOorwinSyncPage } from "@/components/dataset/candidate-oorwin-sync-page";

export const metadata: Metadata = {
  title: "Candidate Dataset",
};

export default function DatasetCandidatePage() {
  return (
    <PageTransition>
      <CandidateOorwinSyncPage />
    </PageTransition>
  );
}
