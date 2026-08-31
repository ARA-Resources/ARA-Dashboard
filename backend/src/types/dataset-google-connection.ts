import {
  DATASET_SYNC_NAMES,
  type DatasetSyncName,
} from "./dataset-sync.js";

export const SHARED_DATASET_CONNECTION_TYPES: readonly DatasetSyncName[] =
  DATASET_SYNC_NAMES;

export type DatasetConnectionLabel = "Connected" | "Not Connected";

export type DatasetServiceConnectionStatus = {
  connected: boolean;
  label: DatasetConnectionLabel;
};

export type SharedGoogleConnectionStatus = {
  oauthConfigured: boolean;
  shared: true;
  datasetTypes: readonly DatasetSyncName[];
  email: string | null;
  expectedEmail: string | null;
  connectedAt: string | null;
  updatedAt: string | null;
  gmail: DatasetServiceConnectionStatus;
  drive: DatasetServiceConnectionStatus;
  scope: string | null;
  today: string;
  lastSuccessfulSyncAt: string | null;
  lastSuccessfulSyncAtMs: number | null;
  lastTrigger: "scheduler" | "manual" | "api" | null;
  error?: string;
};
