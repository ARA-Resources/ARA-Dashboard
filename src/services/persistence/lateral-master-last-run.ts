/**
 * Last Lateral Run All summary for the Master Sheet page banner.
 * Reads durable scheduler state (same path manual + scheduled Run All write).
 */
import { readLateralSchedulerConfig } from "@/services/lateral-processing/lateral-scheduler";
import type { LateralRunLastSummary } from "@/types/lateral-scheduler";

export type LateralMasterLastRunBanner = LateralRunLastSummary;

export async function getLateralMasterLastRunBanner(): Promise<LateralMasterLastRunBanner | null> {
  try {
    const config = await readLateralSchedulerConfig();
    return config.lastRunSummary ?? null;
  } catch {
    return null;
  }
}
