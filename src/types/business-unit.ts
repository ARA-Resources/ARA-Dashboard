export type BusinessUnitId = "lateral" | "executive" | "consulting";

export interface ExcelSourceConfig {
/** Stable filename used only as Dataset Manager bootstrap seed candidate */
  fileName: string;
  relativePath: string;
  /**
   * Unused by runtime. Local workbook location is ARA_LATERAL_EXCEL_PATH
   * or bundled data/excel — never a hardcoded personal machine path.
   */
  absolutePath?: string;
  primarySheet: string;
  /**
   * Optional detail sheet used when applying status filters
   * (e.g. Master Sheet with Job Status / Posted columns).
   */
  detailSheet?: string;
  /** Original uploaded workbook name (documentation only) */
  sourceLabel: string;
  /**
   * Optional 1-based header row hint for pivot-style sheets.
   * When omitted, the reader auto-detects the header row.
   */
  headerRow?: number;
  /** Header row for detailSheet when present */
  detailHeaderRow?: number;
}

export interface BusinessUnitConfig {
  id: BusinessUnitId;
  name: string;
  slug: string;
  description: string;
  excel: ExcelSourceConfig;
}
