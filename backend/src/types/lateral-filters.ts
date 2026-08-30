export type DynamicFilterFieldKind = "categorical" | "numeric";

export interface DynamicFilterField {
  column: string;
  values: string[];
  valueCount: number;
  kind: DynamicFilterFieldKind;
}

export interface DynamicFilterSchema {
  businessUnitId: "lateral";
  sheetName: string;
  sourceFile: string;
  fields: DynamicFilterField[];
}

export type LateralMasterFilterValueColumn =
  | "job_status"
  | "posted"
  | "market_map"
  | "priority"
  | "skill_categorization"
  | "primary_skills"
  | "job_management_level"
  | "primary_location"
  | "poc";
