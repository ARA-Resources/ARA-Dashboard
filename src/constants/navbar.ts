import {
  Building2,
  Database,
  Home,
  LogOut,
  Settings,
  Shield,
  UserRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { getProfileMenuItems } from "@/constants/navigation";
import type { WorkspaceId } from "@/constants/navigation";

export interface ProfileMenuItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  workspace: WorkspaceId;
  variant?: "default" | "destructive";
  action?: "navigate" | "logout";
}

/**
 * Profile menu is derived from the same navigation config as the sidebar
 * so both stay synchronized.
 */
export const PROFILE_MENU: ProfileMenuItem[] = getProfileMenuItems();

/** Icon fallbacks if navigation config is unavailable */
export const PROFILE_ICON_FALLBACK: Record<string, LucideIcon> = {
  home: Home,
  company: Building2,
  candidate: UserRound,
  dataset: Database,
  admin: Shield,
  settings: Settings,
  logout: LogOut,
};

export const NAVBAR = {
  height: 64,
  brandName: "ARA Dashboard",
  logoPath: "/assets/ara-logo.jpg",
  searchPlaceholder: "Search across dashboard…",
} as const;
