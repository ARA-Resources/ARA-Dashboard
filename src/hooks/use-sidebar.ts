"use client";

import { useSidebarStore } from "@/stores/sidebar-store";

export function useSidebar() {
  const collapsed = useSidebarStore((s) => s.collapsed);
  const mobileOpen = useSidebarStore((s) => s.mobileOpen);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);
  const setCollapsed = useSidebarStore((s) => s.setCollapsed);
  const setMobileOpen = useSidebarStore((s) => s.setMobileOpen);

  return {
    collapsed,
    mobileOpen,
    toggleCollapsed,
    setCollapsed,
    setMobileOpen,
  };
}
