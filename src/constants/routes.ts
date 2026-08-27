export const ROUTES = {
  home: "/",
  homePage: "/home",
  company: "/company",
  candidate: "/candidate",
  candidateDashboard: "/candidate/dashboard",
  dataset: "/dataset",
  datasetConnections: "/dataset/connections",
  datasetConnectionsGmail: "/dataset/connections/gmail",
  datasetConnectionsDrive: "/dataset/connections/drive",
  datasetLateral: "/dataset/lateral",
  datasetExecutive: "/dataset/executive",
  datasetConsulting: "/dataset/consulting",
  /** @deprecated Prefer datasetConnections / datasetLateral */
  datasetConfiguration: "/dataset/configuration",
  datasetSyncHistory: "/dataset/sync-history",
  admin: "/admin",
  settings: "/settings",
  logout: "/logout",
  /** @deprecated use company module routes */
  overview: "/company",
  lateral: "/company/accenture/lateral",
  lateralMasterSheet: "/company/accenture/lateral/master-sheet",
  lateralAllocations: "/company/accenture/lateral/allocations",
  executive: "/company/accenture/executive",
  executiveMasterSheet: "/company/accenture/executive/master-sheet",
  consulting: "/company/accenture/consulting",
} as const;

export type AppRoute = (typeof ROUTES)[keyof typeof ROUTES];

export function companyModulePath(companySlug: string, moduleSlug: string) {
  return `/company/${companySlug}/${moduleSlug}`;
}

export function companyModuleSectionPath(
  companySlug: string,
  moduleSlug: string,
  sectionSlug: string
) {
  return `/company/${companySlug}/${moduleSlug}/${sectionSlug}`;
}

export function companyPath(companySlug: string) {
  return `/company/${companySlug}`;
}
