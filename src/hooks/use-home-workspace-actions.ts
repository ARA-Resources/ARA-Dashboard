"use client";

import { useRouter } from "next/navigation";
import { getCompanyById } from "@/constants/companies";
import { useNavigation } from "@/hooks/use-navigation";
import { useHomeWorkspaceStore } from "@/stores/home-workspace-store";
import {
  getCandidateWorkspaceHref,
  getCompanyBusinessUnitHref,
  getCompanyWorkspaceHref,
  getUsableCompanies,
} from "@/utils/home-navigation";
import {
  getCompanyDashboardHref,
  getSettingsHref,
} from "@/utils/home-data";

/**
 * Shared Home Page navigation — same Company / Candidate behavior as before.
 */
export function useHomeWorkspaceActions() {
  const router = useRouter();
  const { expandForWorkspace, setActiveCompanyId } = useNavigation();
  const setPreferredWorkspace = useHomeWorkspaceStore(
    (s) => s.setPreferredWorkspace
  );

  function enterCompany() {
    setPreferredWorkspace("company");
    const usable = getUsableCompanies();
    const href = getCompanyWorkspaceHref();

    if (usable.length === 1) {
      const company = usable[0];
      setActiveCompanyId(company.id);
      expandForWorkspace("company", company.id);
    } else {
      const fallback = getCompanyById(usable[0]?.id ?? "") ?? usable[0];
      if (fallback) {
        setActiveCompanyId(fallback.id);
        expandForWorkspace("company", fallback.id);
      } else {
        expandForWorkspace("company");
      }
    }

    router.push(href);
  }

  function enterCandidate() {
    setPreferredWorkspace("candidate");
    expandForWorkspace("candidate");
    router.push(getCandidateWorkspaceHref());
  }

  function openCompanyDashboard() {
    setPreferredWorkspace("company");
    const usable = getUsableCompanies();
    const company = usable[0];
    if (company) {
      setActiveCompanyId(company.id);
      expandForWorkspace("company", company.id);
    } else {
      expandForWorkspace("company");
    }
    router.push(getCompanyDashboardHref());
  }

  function openBusinessUnit(moduleSlug: string) {
    setPreferredWorkspace("company");
    const usable = getUsableCompanies();
    const company = usable[0];
    if (company) {
      setActiveCompanyId(company.id);
      expandForWorkspace("company", company.id);
    } else {
      expandForWorkspace("company");
    }
    router.push(getCompanyBusinessUnitHref(moduleSlug));
  }

  function openSettings() {
    expandForWorkspace("settings");
    router.push(getSettingsHref());
  }

  function scrollToNotifications() {
    document
      .getElementById("home-dashboard-widgets")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return {
    enterCompany,
    enterCandidate,
    openCompanyDashboard,
    openBusinessUnit,
    openSettings,
    scrollToNotifications,
  };
}
