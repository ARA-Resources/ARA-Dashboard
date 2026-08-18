import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CANDIDATE_MODULES } from "@/constants/navigation";
import { PageHeader } from "@/components/layouts/page-header";
import { DashboardPlaceholder } from "@/components/dashboard/dashboard-placeholder";
import { FilterBarPlaceholder } from "@/components/filters/filter-bar-placeholder";
import { PageTransition } from "@/animations/page-transition";

interface CandidateModulePageProps {
  params: Promise<{ module: string }>;
}

export async function generateMetadata({
  params,
}: CandidateModulePageProps): Promise<Metadata> {
  const { module: moduleSlug } = await params;
  const moduleConfig = CANDIDATE_MODULES.find((item) =>
    item.href.endsWith(`/${moduleSlug}`)
  );
  return { title: moduleConfig?.label ?? "Candidate" };
}

export default async function CandidateModulePage({
  params,
}: CandidateModulePageProps) {
  const { module: moduleSlug } = await params;
  const moduleConfig = CANDIDATE_MODULES.find((item) =>
    item.href.endsWith(`/${moduleSlug}`)
  );

  if (!moduleConfig) {
    notFound();
  }

  return (
    <PageTransition>
      <PageHeader
        title={moduleConfig.label}
        description="Candidate workspace. More options will be added later."
      />
      <FilterBarPlaceholder />
      <DashboardPlaceholder businessUnit="Candidate" />
    </PageTransition>
  );
}
