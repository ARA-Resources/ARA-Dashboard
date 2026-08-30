import type { LateralMasterFilterValueColumn } from "../types/lateral-filters.js";

export const MAX_UNIQUE_VALUES = 150;
export const MIN_UNIQUE_VALUES = 2;

export const LATERAL_JOB_STATUS_FILTER_VALUES = [
  "Active",
  "Closed",
  "New",
  "Reopen",
] as const;

export const LATERAL_PREFERRED_STATUS_VALUES = ["Active", "Reopen", "New"] as const;
export const LATERAL_PREFERRED_POSTED_VALUES = ["Yes"] as const;

export const LATERAL_DASHBOARD_FILTER_COLUMN_MAP: ReadonlyArray<{
  pg: LateralMasterFilterValueColumn;
  excelHeader: string;
  required?: boolean;
}> = [
  { pg: "job_status", excelHeader: "Job Status", required: true },
  { pg: "posted", excelHeader: "Posted", required: true },
  { pg: "market_map", excelHeader: "Market Map", required: true },
  { pg: "priority", excelHeader: "Priority" },
  { pg: "skill_categorization", excelHeader: "Skill Categorization" },
  { pg: "job_management_level", excelHeader: "Job Management Level" },
  { pg: "primary_skills", excelHeader: "Primary Skills" },
  { pg: "primary_location", excelHeader: "Primary Location/Office Locate" },
  { pg: "poc", excelHeader: "POC" },
];

const DISTINCT_SQL: Record<LateralMasterFilterValueColumn, string> = {
  job_status: `SELECT DISTINCT job_status AS value FROM lateral_master
    WHERE job_status IS NOT NULL AND btrim(job_status) <> ''
    ORDER BY value ASC`,
  posted: `SELECT DISTINCT posted AS value FROM lateral_master
    WHERE posted IS NOT NULL AND btrim(posted) <> ''
    ORDER BY value ASC`,
  market_map: `SELECT DISTINCT market_map AS value FROM lateral_master
    WHERE market_map IS NOT NULL AND btrim(market_map) <> ''
    ORDER BY value ASC`,
  priority: `SELECT DISTINCT priority AS value FROM lateral_master
    WHERE priority IS NOT NULL AND btrim(priority) <> ''
    ORDER BY value ASC`,
  skill_categorization: `SELECT DISTINCT skill_categorization AS value FROM lateral_master
    WHERE skill_categorization IS NOT NULL AND btrim(skill_categorization) <> ''
    ORDER BY value ASC`,
  primary_skills: `SELECT DISTINCT primary_skills AS value FROM lateral_master
    WHERE primary_skills IS NOT NULL AND btrim(primary_skills) <> ''
    ORDER BY value ASC`,
  job_management_level: `SELECT DISTINCT job_management_level AS value FROM lateral_master
    WHERE job_management_level IS NOT NULL AND btrim(job_management_level) <> ''
    ORDER BY value ASC`,
  primary_location: `SELECT DISTINCT primary_location AS value FROM lateral_master
    WHERE primary_location IS NOT NULL AND btrim(primary_location) <> ''
    ORDER BY value ASC`,
  poc: `SELECT DISTINCT poc AS value FROM lateral_master
    WHERE poc IS NOT NULL AND btrim(poc) <> ''
    ORDER BY value ASC`,
};

export function distinctValuesSql(column: LateralMasterFilterValueColumn): string {
  return DISTINCT_SQL[column];
}
