/**
 * Stage 24: read-only lateral processing setup GET payload builder.
 */
import { readDatasetSetup } from "./dataset-setup.js";
import { readLateralDataProcessingSetup } from "./lateral-setup-store.js";
import { readLateralSchedulerConfig } from "./lateral-scheduler-config-read.js";
import {
  withLateralDataProcessingDefaults,
  DEFAULT_LATERAL_TIMEZONE,
  type LateralDataProcessingSetup,
} from "../types/lateral-processing-setup.js";

const ENV_DEFAULT_TZ =
  process.env.ARA_DATASET_TZ?.trim() ||
  process.env.TZ?.trim().replace(/^:/, "") ||
  "Asia/Kolkata";

/** Matches Next getDatasetSchedulerTimezone() on a cold process (env/in-memory only). */
function getDatasetSchedulerTimezone(): string {
  return ENV_DEFAULT_TZ || DEFAULT_LATERAL_TIMEZONE;
}

async function buildWizardPayload(
  setup: LateralDataProcessingSetup | null
): Promise<
  Omit<LateralDataProcessingSetup, "updatedAt" | "schedule"> & {
    updatedAt: string;
    schedule: {
      frequency: "daily";
      syncTime: string;
      enabled: boolean;
    };
  }
> {
  const datasetSetup = await readDatasetSetup();
  const lateralSearch = datasetSetup?.datasets?.Lateral;
  const lateralSched = await readLateralSchedulerConfig();
  const lateralSchedule = {
    frequency: "daily" as const,
    syncTime: lateralSched.syncTime,
    enabled: lateralSched.enabled && !lateralSched.paused,
  };

  const base = withLateralDataProcessingDefaults(setup);
  return {
    ...base,
    keywords:
      lateralSearch?.keywords?.length ? lateralSearch.keywords : base.keywords,
    destinationFolder: lateralSearch?.driveFolder?.folderId
      ? {
          mode: lateralSearch.driveFolder.mode,
          folderName: lateralSearch.driveFolder.folderName,
          folderId: lateralSearch.driveFolder.folderId,
          folderUrl: lateralSearch.driveFolder.folderUrl,
        }
      : base.destinationFolder,
    schedule: {
      frequency: "daily",
      syncTime: lateralSchedule.syncTime,
      enabled: lateralSchedule.enabled,
    },
    timezone:
      lateralSched.timezone ||
      getDatasetSchedulerTimezone() ||
      base.timezone,
    updatedAt: setup?.updatedAt ?? new Date(0).toISOString(),
  };
}

export type LateralProcessingSetupGetResponse = {
  configured: boolean;
  updatedAt: string | null;
  setup: Awaited<ReturnType<typeof buildWizardPayload>>;
};

export async function getLateralProcessingSetupResponse(): Promise<LateralProcessingSetupGetResponse> {
  const setup = await readLateralDataProcessingSetup();
  const merged = await buildWizardPayload(setup);
  return {
    configured: Boolean(setup),
    updatedAt: setup?.updatedAt ?? null,
    setup: merged,
  };
}
