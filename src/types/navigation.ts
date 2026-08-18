import type { LucideIcon } from "lucide-react";
import type { WorkspaceId } from "@/constants/navigation";

/** @deprecated Prefer NavSection / NavLeaf from constants/navigation */
export interface SidebarNavItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  disabled?: boolean;
  children?: SidebarNavItem[];
}

export interface PageMeta {
  title: string;
  description?: string;
}

export type { WorkspaceId };
