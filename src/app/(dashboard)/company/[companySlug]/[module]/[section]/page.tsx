import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getCompanyBySlug,
  getCompanyModule,
  getCompanyModuleSection,
} from "@/constants/companies";
import { LateralAllocationsPage } from "@/components/dashboard/accenture/allocations";
import { LateralMasterSheetPage } from "@/components/dashboard/accenture/lateral";
import { PageTransition } from "@/animations/page-transition";

interface ModuleSectionPageProps {
  params: Promise<{
    companySlug: string;
    module: string;
    section: string;
  }>;
}

export async function generateMetadata({
  params,
}: ModuleSectionPageProps): Promise<Metadata> {
  const {
    companySlug,
    module: moduleSlug,
    section: sectionSlug,
  } = await params;
  const company = getCompanyBySlug(companySlug);
  const moduleConfig = getCompanyModule(companySlug, moduleSlug);
  const section = getCompanyModuleSection(
    companySlug,
    moduleSlug,
    sectionSlug
  );

  return {
    title: section
      ? `${section.label} · ${moduleConfig?.label ?? "Module"} · ${company?.name ?? "Company"}`
      : "Section",
  };
}

export default async function CompanyModuleSectionPage({
  params,
}: ModuleSectionPageProps) {
  const {
    companySlug,
    module: moduleSlug,
    section: sectionSlug,
  } = await params;
  const company = getCompanyBySlug(companySlug);
  const moduleConfig = getCompanyModule(companySlug, moduleSlug);
  const section = getCompanyModuleSection(
    companySlug,
    moduleSlug,
    sectionSlug
  );

  if (!company?.enabled || !moduleConfig || !section) {
    notFound();
  }

  if (
    company.slug === "accenture" &&
    moduleConfig.slug === "lateral" &&
    section.slug === "master-sheet"
  ) {
    return <LateralMasterSheetPage />;
  }

  if (
    company.slug === "accenture" &&
    moduleConfig.slug === "lateral" &&
    section.slug === "allocations"
  ) {
    return <LateralAllocationsPage />;
  }

  return (
    <PageTransition>
      <div className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-lg font-semibold text-primary">{section.label}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {company.name} · {moduleConfig.label} · {section.label}
        </p>
      </div>
    </PageTransition>
  );
}
