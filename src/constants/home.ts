/**
 * Static Home Page copy & navigation config (not Excel metrics).
 * Dashboard numbers live in `data/mock/home-widgets.mock.ts` → `services/home`.
 */
import type { BusinessUnitId } from "@/types/business-unit";

export const HOME_META = {
  productName: "ARA Dashboard",
  version: "1.0",
  builtFor: "ARA",
  defaultUserLabel: "Admin",
  heroTitle: "Welcome to ARA Dashboard",
  heroDescription:
    "Centralized dashboard for managing companies, job openings, candidates and analytics.",
} as const;

export interface HomeQuickActionItem {
  id: string;
  title: string;
  description: string;
  icon: "company" | "candidate";
  action: "company" | "candidate";
}

/** Navigation-only business unit cards — metrics come from home widgets */
export interface HomeBusinessUnitNavItem {
  id: BusinessUnitId;
  name: string;
  description: string;
  moduleSlug: string;
  icon: "lateral" | "executive" | "consulting";
}

export const HOME_QUICK_ACTIONS: HomeQuickActionItem[] = [
  {
    id: "open-company",
    title: "Open Company Dashboard",
    description: "Jump into company analytics and job openings.",
    icon: "company",
    action: "company",
  },
  {
    id: "open-candidate",
    title: "Open Candidate Dashboard",
    description: "Access candidate workspace and future features.",
    icon: "candidate",
    action: "candidate",
  },
];

export const HOME_BUSINESS_UNIT_NAV: HomeBusinessUnitNavItem[] = [
  {
    id: "lateral",
    name: "Lateral",
    description: "Lateral DS AI roles, pipeline health, and demand tracking.",
    moduleSlug: "lateral",
    icon: "lateral",
  },
  {
    id: "executive",
    name: "Executive",
    description: "Executive requisitions and leadership hiring overview.",
    moduleSlug: "executive",
    icon: "executive",
  },
  {
    id: "consulting",
    name: "Consulting",
    description: "Consulting demand and openings across practices.",
    moduleSlug: "consulting",
    icon: "consulting",
  },
];
