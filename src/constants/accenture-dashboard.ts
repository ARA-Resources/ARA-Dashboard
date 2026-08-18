import type { BusinessUnitId } from "@/types/business-unit";
import { getCompanyBySlug } from "@/constants/companies";

export interface DashboardBusinessUnitOption {
  id: BusinessUnitId;
  label: string;
  slug: string;
}

/**
 * Business units available on the Accenture Dashboard dropdown.
 * Derived from the company registry — not hardcoded elsewhere.
 */
export function getAccentureDashboardBusinessUnits(): DashboardBusinessUnitOption[] {
  const accenture = getCompanyBySlug("accenture");
  if (!accenture) return [];

  return accenture.modules
    .filter(
      (module): module is typeof module & { businessUnitId: BusinessUnitId } =>
        Boolean(module.businessUnitId)
    )
    .map((module) => ({
      id: module.businessUnitId,
      label: module.label,
      slug: module.slug,
    }));
}

export const DEFAULT_DASHBOARD_BUSINESS_UNIT: BusinessUnitId = "lateral";

export const OPENINGS_TABLE = {
  title: "Top 10 Openings",
  pageSize: 10,
} as const;
