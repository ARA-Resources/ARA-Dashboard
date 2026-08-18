import type { LucideIcon } from "lucide-react";
import {
  Briefcase,
  Building2,
  Database,
  HardDrive,
  Home,
  LayoutDashboard,
  Link2,
  LogOut,
  Mail,
  Settings,
  Shield,
  UserRound,
  Users,
  UserCog,
} from "lucide-react";
import {
  COMPANIES,
  getCompanyDefaultHref,
  getCompanyModuleHref,
  getEnabledCompanies,
  type CompanyConfig,
  type CompanyModuleConfig,
} from "@/constants/companies";
import { ROUTES } from "@/constants/routes";

export type WorkspaceId =
  | "home"
  | "company"
  | "candidate"
  | "dataset"
  | "admin"
  | "settings"
  | "logout";

export interface NavLeaf {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Optional badge (e.g. Coming soon) */
  badge?: string;
}

export interface NavModuleNode {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Nested leaves (e.g. Allocations under Lateral) */
  children?: NavLeaf[];
}

export interface NavCompanyNode {
  id: string;
  label: string;
  slug: string;
  href: string;
  icon: LucideIcon;
  modules: NavModuleNode[];
}

export interface NavSection {
  id: WorkspaceId;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Profile + sidebar sync key */
  workspace: WorkspaceId;
  expandable: boolean;
  companies?: NavCompanyNode[];
  /** Flat children (Candidate) */
  children?: NavLeaf[];
  /**
   * Nested groups under a workspace (Dataset: Common Connections / Datasets).
   * Rendered like Company modules without a company layer.
   */
  groups?: NavModuleNode[];
  action?: "navigate" | "logout";
  variant?: "default" | "destructive";
  /** Optional sidebar badge (e.g. NEW) */
  badge?: string;
}

const MODULE_ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  lateral: Users,
  executive: Briefcase,
  consulting: Building2,
  allocations: UserCog,
};

function moduleIcon(moduleId: string): LucideIcon {
  return MODULE_ICONS[moduleId] ?? LayoutDashboard;
}

function buildModuleNode(
  company: CompanyConfig,
  module: CompanyModuleConfig
): NavModuleNode {
  return {
    id: `company:${company.id}:${module.id}`,
    label: module.label,
    href: getCompanyModuleHref(company.slug, module),
    icon: moduleIcon(module.id),
    children: module.children?.map((child) => ({
      id: `company:${company.id}:${module.id}:${child.id}`,
      label: child.label,
      href: `/company/${company.slug}/${module.slug}/${child.slug}`,
      icon: moduleIcon(child.id),
    })),
  };
}

function buildCompanyNode(company: CompanyConfig): NavCompanyNode {
  return {
    id: `company:${company.id}`,
    label: company.name,
    slug: company.slug,
    href: getCompanyDefaultHref(company),
    icon: Building2,
    modules: company.modules.map((module) => buildModuleNode(company, module)),
  };
}

/**
 * Candidate modules — extend here as Candidate grows.
 * Kept separate from companies config on purpose.
 */
export const CANDIDATE_MODULES: NavLeaf[] = [
  {
    id: "candidate:dashboard",
    label: "Dashboard",
    href: "/candidate/dashboard",
    icon: LayoutDashboard,
  },
];

/**
 * Dataset sidebar tree:
 *   Common Connections → Gmail, Google Drive
 *   Datasets → Lateral, Executive, Consulting
 */
export const DATASET_GROUPS: NavModuleNode[] = [
  {
    id: "dataset:common-connections",
    label: "Common Connections",
    href: ROUTES.datasetConnections,
    icon: Link2,
    children: [
      {
        id: "dataset:connections:gmail",
        label: "Gmail",
        href: ROUTES.datasetConnectionsGmail,
        icon: Mail,
      },
      {
        id: "dataset:connections:drive",
        label: "Google Drive",
        href: ROUTES.datasetConnectionsDrive,
        icon: HardDrive,
      },
    ],
  },
  {
    id: "dataset:datasets",
    label: "Datasets",
    href: ROUTES.datasetLateral,
    icon: Database,
    children: [
      {
        id: "dataset:lateral",
        label: "Lateral",
        href: ROUTES.datasetLateral,
        icon: Users,
      },
      {
        id: "dataset:executive",
        label: "Executive",
        href: ROUTES.datasetExecutive,
        icon: Briefcase,
        badge: "Soon",
      },
      {
        id: "dataset:consulting",
        label: "Consulting",
        href: ROUTES.datasetConsulting,
        icon: Building2,
        badge: "Soon",
      },
    ],
  },
];

/** @deprecated Prefer DATASET_GROUPS — kept for any flat-list callers */
export const DATASET_MODULES: NavLeaf[] = DATASET_GROUPS.flatMap(
  (group) => group.children ?? []
);

export function buildSidebarSections(): NavSection[] {
  const companies = getEnabledCompanies().map(buildCompanyNode);

  return [
    {
      id: "home",
      label: "Home",
      href: ROUTES.homePage,
      icon: Home,
      workspace: "home",
      expandable: false,
      action: "navigate",
    },
    {
      id: "company",
      label: "Company",
      href: "/company",
      icon: Building2,
      workspace: "company",
      expandable: true,
      companies,
      action: "navigate",
    },
    {
      id: "candidate",
      label: "Candidate",
      href: "/candidate/dashboard",
      icon: UserRound,
      workspace: "candidate",
      expandable: true,
      children: CANDIDATE_MODULES,
      action: "navigate",
    },
    {
      id: "dataset",
      label: "Dataset",
      href: ROUTES.datasetLateral,
      icon: Database,
      workspace: "dataset",
      expandable: true,
      groups: DATASET_GROUPS,
      action: "navigate",
    },
    {
      id: "admin",
      label: "Admin",
      href: "/admin",
      icon: Shield,
      workspace: "admin",
      expandable: false,
      action: "navigate",
    },
    {
      id: "settings",
      label: "Settings",
      href: "/settings",
      icon: Settings,
      workspace: "settings",
      expandable: false,
      action: "navigate",
    },
    {
      id: "logout",
      label: "Logout",
      href: "/logout",
      icon: LogOut,
      workspace: "logout",
      expandable: false,
      action: "logout",
      variant: "destructive",
    },
  ];
}

/** Memo-friendly accessor — rebuild when COMPANIES changes (module reload). */
export const SIDEBAR_SECTIONS = buildSidebarSections();

/**
 * Active nav matching that prefers the most specific sibling href.
 * Prevents `/dataset` lighting up while on `/dataset/configuration`.
 */
export function isNavHrefActive(
  pathname: string,
  href: string,
  siblingHrefs: readonly string[] = []
): boolean {
  if (pathname === href) return true;
  if (!pathname.startsWith(`${href}/`)) return false;

  const hasMoreSpecificSibling = siblingHrefs.some(
    (other) =>
      other !== href &&
      other.length > href.length &&
      (pathname === other || pathname.startsWith(`${other}/`))
  );
  return !hasMoreSpecificSibling;
}

export function getWorkspaceDefaultHref(workspace: WorkspaceId): string {
  const section = SIDEBAR_SECTIONS.find((item) => item.workspace === workspace);
  return section?.href ?? ROUTES.homePage;
}

export function resolveWorkspaceFromPathname(pathname: string): WorkspaceId {
  if (pathname === "/home" || pathname === "/") return "home";
  if (pathname.startsWith("/candidate")) return "candidate";
  if (pathname.startsWith("/dataset")) return "dataset";
  if (pathname.startsWith("/admin")) return "admin";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/logout")) return "logout";
  if (pathname.startsWith("/company")) return "company";
  return "home";
}

export function resolveCompanySlugFromPathname(
  pathname: string
): string | null {
  const match = pathname.match(/^\/company\/([^/]+)/);
  return match?.[1] ?? null;
}

export function resolveModuleSlugFromPathname(
  pathname: string
): string | null {
  const match = pathname.match(/^\/company\/[^/]+\/([^/]+)/);
  return match?.[1] ?? null;
}

/** Dataset group key for sidebar expand sync */
export function resolveDatasetGroupIdFromPathname(
  pathname: string
): string | null {
  if (!pathname.startsWith("/dataset")) return null;
  if (
    pathname.startsWith("/dataset/connections") ||
    pathname.startsWith("/dataset/configuration")
  ) {
    return "common-connections";
  }
  if (
    pathname.startsWith("/dataset/lateral") ||
    pathname.startsWith("/dataset/executive") ||
    pathname.startsWith("/dataset/consulting") ||
    pathname.startsWith("/dataset/sync-history")
  ) {
    return "datasets";
  }
  return "datasets";
}

export function getProfileMenuItems() {
  return SIDEBAR_SECTIONS.filter((section) =>
    ["company", "candidate", "dataset", "admin", "settings", "logout"].includes(
      section.id
    )
  ).map((section) => ({
    id: section.id,
    label: section.label,
    href: section.href,
    icon: section.icon,
    workspace: section.workspace,
    action: section.action ?? "navigate",
    variant: section.variant,
  }));
}

/** Re-export for convenience when adding companies */
export { COMPANIES };
