import { redirect, notFound } from "next/navigation";
import {
  getCompanyBySlug,
  getCompanyModule,
  getCompanyModuleHref,
} from "@/constants/companies";
import { AccentureDashboard } from "@/components/dashboard/accenture";
import { getBusinessUnitById } from "@/constants/business-units";
import { PageHeader } from "@/components/layouts/page-header";
import { DashboardPlaceholder } from "@/components/dashboard/dashboard-placeholder";
import { DataTablePlaceholder } from "@/components/tables/data-table-placeholder";
import { ChartPlaceholder } from "@/components/charts/chart-placeholder";
import { FilterBarPlaceholder } from "@/components/filters/filter-bar-placeholder";
import { PageTransition } from "@/animations/page-transition";
import type { Metadata } from "next";

interface ModulePageProps {
  params: Promise<{ companySlug: string; module: string }>;
}

export async function generateMetadata({
  params,
}: ModulePageProps): Promise<Metadata> {
  const { companySlug, module: moduleSlug } = await params;
  const company = getCompanyBySlug(companySlug);
  const moduleConfig = getCompanyModule(companySlug, moduleSlug);

  if (companySlug === "accenture" && moduleSlug === "dashboard") {
    return { title: "Dashboard · Accenture" };
  }

  return {
    title: moduleConfig
      ? `${moduleConfig.label} · ${company?.name ?? "Company"}`
      : "Module",
  };
}

export default async function CompanyModulePage({ params }: ModulePageProps) {
  const { companySlug, module: moduleSlug } = await params;
  const company = getCompanyBySlug(companySlug);
  const moduleConfig = getCompanyModule(companySlug, moduleSlug);

  if (!company?.enabled || !moduleConfig) {
    notFound();
  }

  if (company.slug === "accenture" && moduleConfig.slug === "dashboard") {
    return <AccentureDashboard />;
  }

  // Folder modules (e.g. Lateral) open their first section
  if (moduleConfig.children && moduleConfig.children.length > 0) {
    redirect(getCompanyModuleHref(company.slug, moduleConfig));
  }

  const businessUnit = moduleConfig.businessUnitId
    ? getBusinessUnitById(moduleConfig.businessUnitId)
    : undefined;

  return (
    <PageTransition>
      <PageHeader
        title={moduleConfig.label}
        description={
          businessUnit
            ? `${company.name} · ${businessUnit.description}. Sheet: ${businessUnit.excel.primarySheet}`
            : `${company.name} · ${moduleConfig.label} workspace`
        }
      />
      <FilterBarPlaceholder />
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <ChartPlaceholder title={`${moduleConfig.label} trends`} />
        <ChartPlaceholder title={`${moduleConfig.label} distribution`} />
      </div>
      <DashboardPlaceholder
        businessUnit={businessUnit?.name ?? moduleConfig.label}
        sheetName={businessUnit?.excel.primarySheet}
      />
      <div className="mt-4">
        <DataTablePlaceholder
          title={
            businessUnit
              ? `${businessUnit.excel.primarySheet} (placeholder)`
              : `${moduleConfig.label} table (placeholder)`
          }
        />
      </div>
    </PageTransition>
  );
}
