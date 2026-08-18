export const SIDEBAR = {
  widthExpanded: 280,
  widthCollapsed: 72,
  brandName: "ARA Dashboard",
  logoPath: "/assets/ara-logo.jpg",
} as const;

/** @deprecated Use SIDEBAR_SECTIONS from constants/navigation */
export { SIDEBAR_SECTIONS as SIDEBAR_NAV } from "@/constants/navigation";
