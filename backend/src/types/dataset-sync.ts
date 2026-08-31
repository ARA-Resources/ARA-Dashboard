export const DATASET_SYNC_NAMES = ["Lateral", "Executive", "Consulting"] as const;
export type DatasetSyncName = (typeof DATASET_SYNC_NAMES)[number];
