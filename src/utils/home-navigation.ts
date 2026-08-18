import {
  getCompanyDefaultHref,
  getCompanyModuleHref,
  getEnabledCompanies,
  type CompanyConfig,
} from "@/constants/companies";
import { companyModulePath, ROUTES } from "@/constants/routes";

/** Enabled companies that already have dashboard modules */
export function getUsableCompanies(): CompanyConfig[] {
  return getEnabledCompanies().filter((company) => company.modules.length > 0);
}

/**
 * Destination after choosing Company on the Home Page.
 * One usable company → that company's Dashboard; otherwise default company entry.
 */
export function getCompanyWorkspaceHref(): string {
  const usable = getUsableCompanies();
  if (usable.length === 1) {
    return getCompanyDefaultHref(usable[0]);
  }
  if (usable.length > 0) {
    return getCompanyDefaultHref(usable[0]);
  }
  return ROUTES.company;
}

export function getCandidateWorkspaceHref(): string {
  return ROUTES.candidateDashboard;
}

/** Company → Accenture (or first usable) → module (lateral / executive / consulting) */
export function getCompanyBusinessUnitHref(moduleSlug: string): string {
  const usable = getUsableCompanies();
  const company = usable[0];
  if (!company) return ROUTES.company;
  const module = company.modules.find((item) => item.slug === moduleSlug);
  if (module) {
    return getCompanyModuleHref(company.slug, module);
  }
  return companyModulePath(company.slug, moduleSlug);
}
