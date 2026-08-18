import { DATASET_SYNC_NAMES, type DatasetSyncName } from "@/types/dataset-sync";

/**
 * One Google OAuth identity for Dataset Manager.
 * Gmail + Drive share the same encrypted backend tokens.
 *
 * Extensible architecture:
 *   Common Gmail Connection  → Lateral / Executive / Consulting
 *   Common Drive Connection  → Lateral / Executive / Consulting
 *   Independent schedule / keywords / checkpoint / folder / Master / logic
 *
 * Current execution scope: Lateral only (see dataset-execution.ts).
 */
export const SHARED_DATASET_CONNECTION_TYPES: readonly DatasetSyncName[] =
  DATASET_SYNC_NAMES;

export type DatasetConnectionLabel = "Connected" | "Not Connected";

export interface DatasetServiceConnectionStatus {
  connected: boolean;
  label: DatasetConnectionLabel;
}

export interface SharedGoogleConnectionStatus {
  /** Env GOOGLE_CLIENT_ID / SECRET present */
  oauthConfigured: boolean;
  /** Always true — architecture is intentionally single-connection */
  shared: true;
  /** Dataset types that consume this connection */
  datasetTypes: readonly DatasetSyncName[];
  /** Authenticated Google account email (from OAuth profile) */
  email: string | null;
  /** Expected mailbox from Dataset setup (login_hint) */
  expectedEmail: string | null;
  connectedAt: string | null;
  updatedAt: string | null;
  /** Gmail API usable via the shared OAuth tokens */
  gmail: DatasetServiceConnectionStatus;
  /** Drive API usable via the same shared OAuth tokens */
  drive: DatasetServiceConnectionStatus;
  /** Granted OAuth scopes string from stored tokens (no secrets) */
  scope: string | null;
  today: string;
  lastSuccessfulSyncAt: string | null;
  lastSuccessfulSyncAtMs: number | null;
  lastTrigger: "scheduler" | "manual" | "api" | null;
  error?: string;
}
