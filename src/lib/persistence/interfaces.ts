/**
 * Typed domain-specific persistence interfaces.
 *
 * Each interface is implemented by two classes:
 *   File<X>Store  — delegates to the existing .data/ JSON store (unchanged)
 *   Postgres<X>Store — reads/writes PostgreSQL
 *
 * Resolved at runtime via getPersistenceMode() / store factory.
 */

import type { LateralGmailCheckpoint } from "@/types/lateral-gmail-checkpoint";
import type { LateralSchedulerConfig } from "@/types/lateral-scheduler";
import type {
  LateralSyncHistoryEntry,
} from "@/types/lateral-sync-history";
import type { DatasetSyncWatermark } from "@/services/dataset/sync-watermark-store";
import type { AppNotification, AppNotificationKind } from "@/types/notifications";
import type {
  HomeWidgetsMetricsSnapshot,
  MergeHomeUnitMetricsInput,
} from "@/services/home/home-widgets-metrics-store";
import type { BusinessUnitId } from "@/types/business-unit";
import type { LateralSourceDriveState } from "@/services/lateral-processing/lateral-source-drive-state-store";

// ─── Gmail Checkpoint ────────────────────────────────────────────────────────

export interface GmailCheckpointStore {
  /**
   * Read the current checkpoint. Returns an empty (null-fields) checkpoint
   * if no record exists yet.
   */
  read(accountEmail?: string): Promise<LateralGmailCheckpoint>;

  /**
   * Advance the checkpoint atomically.
   *
   * PostgreSQL implementation:
   *   UPDATE gmail_checkpoint
   *   SET message_id = $new, received_at_ms = $newMs, ...
   *   WHERE account_email = $account
   *     AND (received_at_ms IS NULL OR received_at_ms <= $prevMs)
   *
   * Only succeeds if no other worker has already written a NEWER checkpoint.
   * Throws if processingResult !== 'SUCCESS'.
   */
  advance(input: {
    messageId: string;
    attachmentId: string;
    receivedAt: string;
    receivedAtMs: number;
    attachmentFilename: string;
    driveFileId: string;
    processedAt?: string;
    processingResult: "SUCCESS";
    accountEmail?: string;
  }): Promise<LateralGmailCheckpoint>;
}

// ─── OAuth / Encrypted Config ─────────────────────────────────────────────────

export interface EncryptedConfigStore {
  /**
   * Read an encrypted configuration blob by key.
   * Returns null if not found.
   * Decryption is performed by the caller using existing encrypted-json-store utilities.
   */
  readRawEnvelope(key: string): Promise<string | null>;

  /**
   * Write an encrypted configuration blob.
   * The value must already be an AES-256-GCM JSON envelope string.
   */
  writeRawEnvelope(key: string, envelope: string): Promise<void>;

  /** Remove a key. */
  deleteKey(key: string): Promise<void>;
}

// ─── Scheduler State ─────────────────────────────────────────────────────────

export interface SchedulerStateStore {
  readLateral(): Promise<LateralSchedulerConfig>;
  writeLateral(config: Partial<LateralSchedulerConfig>): Promise<LateralSchedulerConfig>;
}

// ─── Lateral Sync History ────────────────────────────────────────────────────

export interface LateralSyncHistoryStoreInterface {
  list(limit?: number): Promise<LateralSyncHistoryEntry[]>;
  append(entry: Omit<LateralSyncHistoryEntry, "id">): Promise<LateralSyncHistoryEntry>;
}

// ─── Sync Watermark ──────────────────────────────────────────────────────────

export interface SyncWatermarkStoreInterface {
  read(): Promise<DatasetSyncWatermark>;
  write(
    partial: Partial<
      Pick<DatasetSyncWatermark, "lastSuccessfulSyncAt" | "lastSuccessfulSyncAtMs" | "lastTrigger">
    >
  ): Promise<DatasetSyncWatermark>;
}

// ─── Lateral Source Drive State ──────────────────────────────────────────────

export interface LateralSourceDriveStateStoreInterface {
  read(): Promise<LateralSourceDriveState>;
  write(state: LateralSourceDriveState): Promise<LateralSourceDriveState>;
}

// ─── Home Metrics ─────────────────────────────────────────────────────────────

export interface HomeMetricsStoreInterface {
  readSnapshot(): Promise<HomeWidgetsMetricsSnapshot>;
  writeSnapshot(snapshot: HomeWidgetsMetricsSnapshot): Promise<HomeWidgetsMetricsSnapshot>;
  mergeUnit(
    businessUnitId: BusinessUnitId,
    incoming: MergeHomeUnitMetricsInput
  ): Promise<HomeWidgetsMetricsSnapshot>;
}

// ─── OAuth State ─────────────────────────────────────────────────────────────

export interface OAuthStatePayload {
  /** The Gmail address expected to be authorized. */
  expectedEmail: string;
  /** ISO-8601 expiry timestamp. */
  expiresAt: string;
}

export interface OAuthStateStore {
  /**
   * Persist a new OAuth state token.
   * Multiple concurrent attempts each get their own row (keyed by state token).
   * TTL: 10 minutes.
   */
  save(state: string, payload: OAuthStatePayload): Promise<void>;

  /**
   * Consume (read + delete) a state token.
   * Returns null when the token does not exist or is expired.
   * Single-use: the row is deleted atomically on successful retrieval.
   */
  consume(state: string): Promise<OAuthStatePayload | null>;
}

// ─── App Notifications ───────────────────────────────────────────────────────

export interface AppNotificationsStoreInterface {
  list(limit?: number): Promise<AppNotification[]>;
  countUnread(): Promise<number>;
  push(input: {
    kind: AppNotificationKind;
    title: string;
    body: string;
    href?: string;
    meta?: Record<string, unknown>;
  }): Promise<AppNotification>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
  delete(id: string): Promise<void>;
}
