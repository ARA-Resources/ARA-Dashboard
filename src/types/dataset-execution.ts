/**
 * Dataset execution scope.
 *
 * Architecture (extensible):
 *   Common Gmail Connection  → Lateral / Executive / Consulting
 *   Common Google Drive Connection → Lateral / Executive / Consulting
 *   Independent schedule / keywords / checkpoint / Drive folder /
 *   Master Workbook / processing logic per dataset type
 *
 * SCOPE RESTRICTION (current):
 *   ONLY Lateral is fully implemented and allowed to execute jobs/sync.
 *   Executive and Consulting must NOT run until their dedicated
 *   schedulers + pipelines exist. Do not add placeholder executors.
 */
import {
  DATASET_SYNC_NAMES,
  type DatasetSyncName,
} from "@/types/dataset-sync";

/** Fully implemented — may schedule and run processing jobs. */
export const EXECUTABLE_DATASET_TYPES = ["Lateral"] as const;
export type ExecutableDatasetType = (typeof EXECUTABLE_DATASET_TYPES)[number];

/**
 * Configured for future independent processing.
 * May keep shared Gmail/Drive + per-type keywords/folders in setup,
 * but must never execute sync/processing jobs yet.
 */
export const FUTURE_DATASET_TYPES = ["Executive", "Consulting"] as const;
export type FutureDatasetType = (typeof FUTURE_DATASET_TYPES)[number];

export const LATERAL_ONLY_EXECUTION_MESSAGE =
  "Only Lateral Dataset automation runs currently. Executive and Consulting processing is not enabled yet (shared Gmail/Drive architecture is retained for a later release).";

export function isDatasetSyncName(value: string): value is DatasetSyncName {
  return (DATASET_SYNC_NAMES as readonly string[]).includes(value);
}

export function isExecutableDatasetType(
  value: string
): value is ExecutableDatasetType {
  return (EXECUTABLE_DATASET_TYPES as readonly string[]).includes(value);
}

export function isFutureDatasetType(value: string): value is FutureDatasetType {
  return (FUTURE_DATASET_TYPES as readonly string[]).includes(value);
}

/** Keep only currently executable dataset names (order preserved). */
export function filterExecutableDatasetNames(
  names?: readonly string[] | null
): ExecutableDatasetType[] {
  const source =
    names && names.length > 0 ? names : [...EXECUTABLE_DATASET_TYPES];
  const out: ExecutableDatasetType[] = [];
  for (const name of source) {
    if (isExecutableDatasetType(name) && !out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

export function assertExecutableDatasetType(
  name: string
): asserts name is ExecutableDatasetType {
  if (!isExecutableDatasetType(name)) {
    throw new Error(
      `${name} processing is not enabled yet. ${LATERAL_ONLY_EXECUTION_MESSAGE}`
    );
  }
}

/**
 * Resolve which datasets a sync/job request may run.
 * Throws when the request targets only non-executable types.
 */
export function resolveExecutableDatasetNamesForRun(
  names?: readonly string[] | null
): {
  executable: ExecutableDatasetType[];
  skippedFuture: FutureDatasetType[];
} {
  const requested =
    names && names.length > 0
      ? names.filter(isDatasetSyncName)
      : [...EXECUTABLE_DATASET_TYPES];

  const executable = filterExecutableDatasetNames(requested);
  const skippedFuture = requested.filter(isFutureDatasetType);

  if (executable.length === 0) {
    throw new Error(LATERAL_ONLY_EXECUTION_MESSAGE);
  }

  return { executable, skippedFuture };
}
