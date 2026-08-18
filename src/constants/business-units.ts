import type { BusinessUnitConfig } from "@/types/business-unit";

/**
 * Registry of business units and their Excel *sheet layout* contracts.
 *
 * Lateral Company dashboard primary source is the configured Google Drive XLSM
 * (ARA_LATERAL_MASTER_DRIVE_FILE_ID). Local workbook path is optional
 * (ARA_LATERAL_EXCEL_PATH or bundled data/excel).
 */
export const BUSINESS_UNITS: BusinessUnitConfig[] = [
  {
    id: "lateral",
    name: "Lateral",
    slug: "lateral",
    description: "Lateral DS AI roles and pipeline",
    excel: {
      fileName: "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm",
      relativePath: "data/excel/lateral-mastersheet.xlsm",
      // Dashboard openings: filter Master Sheet (Job Status / Posted / Market Map)
      // then aggregate into a P-Roles-style table from the Drive XLSM.
      primarySheet: "P-Roles",
      detailSheet: "Master Sheet",
      detailHeaderRow: 1,
      sourceLabel:
        "Google Drive XLSM · Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm · Master Sheet → openings",
      headerRow: 6,
    },
  },
  {
    id: "executive",
    name: "Executive",
    slug: "executive",
    description: "Executive job requisitions",
    excel: {
      fileName: "executive-mastersheet.xlsm",
      relativePath: "data/excel/executive-mastersheet.xlsm",
      primarySheet: "P - Dashboard",
      detailSheet: "Master Sheet",
      detailHeaderRow: 1,
      sourceLabel: "Executive Dataset (Dataset Manager)",
      headerRow: 7,
    },
  },
  {
    id: "consulting",
    name: "Consulting",
    slug: "consulting",
    description: "Consulting demand tracker",
    excel: {
      fileName: "consulting-demand.xlsx",
      relativePath: "data/excel/consulting-demand.xlsx",
      primarySheet: "Sheet1",
      sourceLabel: "Consulting Dataset (Dataset Manager)",
      headerRow: 1,
    },
  },
];

export const DEFAULT_BUSINESS_UNIT_ID = "lateral" as const;

export function getBusinessUnitBySlug(slug: string) {
  return BUSINESS_UNITS.find((unit) => unit.slug === slug);
}

export function getBusinessUnitById(id: string) {
  return BUSINESS_UNITS.find((unit) => unit.id === id);
}
