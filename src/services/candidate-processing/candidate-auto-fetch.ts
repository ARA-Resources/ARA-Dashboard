/**
 * Unified auto-fetch resolver for the 4 Candidate Master Sheet fields
 * sourced from lateral_master / executive_master by Job Requisition ID:
 * Primary Skills, Job Management Level, Market, Client SPOC.
 *
 * Rule (confirmed, one rule for all 4 fields):
 *  1. Look up the JR ID in lateral_master and executive_master.
 *  2. Found in exactly one → use that table's value.
 *  3. Found in both, values agree (case-insensitive, trimmed) → use it.
 *  4. Found in both, values DISAGREE → do NOT silently prefer either table.
 *     Return `value: null` for that field plus a conflict entry — the
 *     caller (the sync engine) must not overwrite an existing stored value
 *     with this null; it only records the conflict for review.
 *  5. Value not usable from either table (JR not found at all, OR found but
 *     that table has no such field, OR the field is null/blank on that
 *     row) → fall back to the Oorwin sheet's own value for that field.
 *     Job Management Level has no Oorwin fallback — stays null.
 *
 * Client SPOC only ever reads from lateral_master.poc (executive_master has
 * no POC/SPOC-equivalent column at all — verified live, migration 009 never
 * added one), so it can never hit the "found in both, disagree" conflict
 * path; only Primary Skills / Job Management Level / Market can.
 */
import {
  getLateralMasterByJobRequisitionId,
  type SqlClient,
} from "@/services/persistence/read-lateral-master";
import { getExecutiveMasterByJobRequisitionId } from "@/services/persistence/read-executive-master";

export type CandidateAutoFetchField =
  | "primarySkills"
  | "jobManagementLevel"
  | "market"
  | "clientSpoc";

export interface CandidateAutoFetchConflict {
  field: CandidateAutoFetchField;
  lateralValue: string;
  executiveValue: string;
}

export interface CandidateAutoFetchValues {
  primarySkills: string | null;
  jobManagementLevel: string | null;
  market: string | null;
  clientSpoc: string | null;
}

export interface CandidateAutoFetchResult {
  values: CandidateAutoFetchValues;
  conflicts: CandidateAutoFetchConflict[];
}

/** Oorwin's own per-field fallback values, used only when neither table has a usable value. */
export interface CandidateAutoFetchOorwinFallbacks {
  /** Oorwin "Customer Job Title" */
  primarySkills: string | null;
  /** Oorwin "Market" */
  market: string | null;
  /** Oorwin "Client SPOC" */
  clientSpoc: string | null;
  // No Oorwin fallback source exists for Job Management Level.
}

function usable(value: string | null | undefined): value is string {
  if (value == null) return false;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed !== "-";
}

function resolveField(
  field: CandidateAutoFetchField,
  lateralValue: string | null,
  executiveValue: string | null,
  oorwinFallback: string | null,
  conflicts: CandidateAutoFetchConflict[]
): string | null {
  const lateralUsable = usable(lateralValue);
  const executiveUsable = usable(executiveValue);

  if (lateralUsable && executiveUsable) {
    const lv = lateralValue.trim();
    const ev = executiveValue.trim();
    if (lv.toLowerCase() === ev.toLowerCase()) return lv;
    conflicts.push({ field, lateralValue: lv, executiveValue: ev });
    return null;
  }
  if (lateralUsable) return lateralValue.trim();
  if (executiveUsable) return executiveValue.trim();
  return usable(oorwinFallback) ? oorwinFallback.trim() : null;
}

export async function resolveCandidateAutoFetchFields(
  jobRequisitionId: string,
  oorwinFallbacks: CandidateAutoFetchOorwinFallbacks,
  sqlClient?: SqlClient
): Promise<CandidateAutoFetchResult> {
  const jr = String(jobRequisitionId ?? "").trim();
  const [lateralRow, executiveRow] =
    jr && jr !== "-"
      ? await Promise.all([
          getLateralMasterByJobRequisitionId(jr, sqlClient),
          getExecutiveMasterByJobRequisitionId(jr, sqlClient),
        ])
      : [null, null];

  const conflicts: CandidateAutoFetchConflict[] = [];

  const values: CandidateAutoFetchValues = {
    primarySkills: resolveField(
      "primarySkills",
      lateralRow?.primary_skills ?? null,
      executiveRow?.primary_skills ?? null,
      oorwinFallbacks.primarySkills,
      conflicts
    ),
    jobManagementLevel: resolveField(
      "jobManagementLevel",
      lateralRow?.job_management_level ?? null,
      executiveRow?.job_management_level ?? null,
      null,
      conflicts
    ),
    market: resolveField(
      "market",
      lateralRow?.market_map ?? null,
      executiveRow?.market_map ?? null,
      oorwinFallbacks.market,
      conflicts
    ),
    clientSpoc: resolveField(
      "clientSpoc",
      lateralRow?.poc ?? null,
      null, // executive_master has no POC/SPOC-equivalent column
      oorwinFallbacks.clientSpoc,
      conflicts
    ),
  };

  return { values, conflicts };
}
