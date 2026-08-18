/**
 * Company registry — add new companies here only.
 * Sidebar, routes, and profile sync all derive from this file.
 */
import type { BusinessUnitId } from "@/types/business-unit";

export interface CompanyModuleConfig {
  id: string;
  label: string;
  slug: string;
  /** Optional link to Excel business-unit registry */
  businessUnitId?: BusinessUnitId;
  /** Nested sections under this module (e.g. Lateral → Allocations) */
  children?: CompanyModuleConfig[];
}

export interface CompanyConfig {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  /** Dashboard modules under this company. Empty = coming soon. */
  modules: CompanyModuleConfig[];
}

/**
 * Add a company by appending an object to this array.
 * Example:
 * {
 *   id: "tcs",
 *   name: "TCS",
 *   slug: "tcs",
 *   enabled: true,
 *   modules: [{ id: "dashboard", label: "Dashboard", slug: "dashboard" }],
 * }
 */
export const COMPANIES: CompanyConfig[] = [
  {
    id: "accenture",
    name: "Accenture",
    slug: "accenture",
    enabled: true,
    modules: [
      { id: "dashboard", label: "Dashboard", slug: "dashboard" },
      {
        id: "lateral",
        label: "Lateral",
        slug: "lateral",
        businessUnitId: "lateral",
        children: [
          {
            id: "master-sheet",
            label: "Master Sheet",
            slug: "master-sheet",
            businessUnitId: "lateral",
          },
          {
            id: "allocations",
            label: "Allocations",
            slug: "allocations",
            businessUnitId: "lateral",
          },
        ],
      },
      {
        id: "executive",
        label: "Executive",
        slug: "executive",
        businessUnitId: "executive",
      },
      {
        id: "consulting",
        label: "Consulting",
        slug: "consulting",
        businessUnitId: "consulting",
      },
    ],
  },
  {
    id: "infosys",
    name: "Infosys",
    slug: "infosys",
    enabled: true,
    modules: [
      // Modules will be added later
    ],
  },
];

/** Fallback when no company is selected — first enabled company */
export const DEFAULT_COMPANY_ID =
  COMPANIES.find((company) => company.enabled)?.id ?? "accenture";

export function getCompanyById(id: string) {
  return COMPANIES.find((company) => company.id === id);
}

export function getCompanyBySlug(slug: string) {
  return COMPANIES.find((company) => company.slug === slug);
}

export function getEnabledCompanies() {
  return COMPANIES.filter((company) => company.enabled);
}

export function getCompanyModule(companySlug: string, moduleSlug: string) {
  const company = getCompanyBySlug(companySlug);
  return company?.modules.find((module) => module.slug === moduleSlug);
}

export function getCompanyModuleSection(
  companySlug: string,
  moduleSlug: string,
  sectionSlug: string
) {
  const moduleConfig = getCompanyModule(companySlug, moduleSlug);
  return moduleConfig?.children?.find((child) => child.slug === sectionSlug);
}

/** Prefer first nested child when a module is a folder (e.g. Lateral → Allocations). */
export function getCompanyModuleHref(
  companySlug: string,
  module: CompanyModuleConfig
) {
  if (module.children && module.children.length > 0) {
    return `/company/${companySlug}/${module.slug}/${module.children[0].slug}`;
  }
  return `/company/${companySlug}/${module.slug}`;
}

export function getDefaultCompany() {
  return getCompanyById(DEFAULT_COMPANY_ID) ?? COMPANIES[0];
}

export function getCompanyDefaultHref(company: CompanyConfig) {
  if (company.modules.length > 0) {
    return getCompanyModuleHref(company.slug, company.modules[0]);
  }
  return `/company/${company.slug}`;
}
