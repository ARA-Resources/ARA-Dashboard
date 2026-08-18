import {
  getCompanyDefaultHref,
  getDefaultCompany,
  getEnabledCompanies,
  type CompanyConfig,
} from "@/constants/companies";
import { companyModulePath, ROUTES } from "@/constants/routes";
import { getUsableCompanies } from "@/utils/home-navigation";

export {
  getUsableCompanies,
  getCompanyWorkspaceHref,
  getCandidateWorkspaceHref,
} from "@/utils/home-navigation";

/** Accenture (or default usable company) module route — never hardcode paths in UI */
export function getDefaultCompanyModuleHref(moduleSlug: string): string {
  const company =
    getUsableCompanies()[0] ?? getDefaultCompany() ?? getEnabledCompanies()[0];
  if (!company) return ROUTES.company;
  return companyModulePath(company.slug, moduleSlug);
}

export function getSettingsHref(): string {
  return ROUTES.settings;
}

export function resolveCompanyForHome(): CompanyConfig | undefined {
  return getUsableCompanies()[0] ?? getDefaultCompany();
}

export function getCompanyDashboardHref(): string {
  const company = resolveCompanyForHome();
  return company ? getCompanyDefaultHref(company) : ROUTES.company;
}
