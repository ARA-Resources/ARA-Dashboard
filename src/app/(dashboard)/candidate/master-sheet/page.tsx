import type { Metadata } from "next";
import { CandidateMasterSheetPage } from "@/components/dashboard/accenture/candidate/candidate-master-sheet-page";

export const metadata: Metadata = {
  title: "Master Sheet",
};

export default function CandidateMasterSheetRoute() {
  return <CandidateMasterSheetPage />;
}
