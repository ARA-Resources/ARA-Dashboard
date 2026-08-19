/**
 * Store factory.
 *
 * Returns the correct implementation based on ARA_PERSISTENCE env var.
 *
 * ARA_PERSISTENCE=file     → File-backed stores (default, existing behavior)
 * ARA_PERSISTENCE=postgres → PostgreSQL-backed stores
 *
 * Usage:
 *   import { getGmailCheckpointStore } from "@/lib/persistence/store-factory";
 *   const store = getGmailCheckpointStore();
 *   const checkpoint = await store.read();
 */

import { isPostgresMode } from "./persistence-mode";

import {
  FileGmailCheckpointStore,
  FileEncryptedConfigStore,
  FileSchedulerStateStore,
  FileLateralSyncHistoryStore,
  FileSyncWatermarkStore,
  FileLateralSourceDriveStateStore,
  FileHomeMetricsStore,
  FileAppNotificationsStore,
  FileOAuthStateStore,
} from "./file-stores";

import {
  PostgresGmailCheckpointStore,
  PostgresEncryptedConfigStore,
  PostgresSchedulerStateStore,
  PostgresLateralSyncHistoryStore,
  PostgresSyncWatermarkStore,
  PostgresLateralSourceDriveStateStore,
  PostgresHomeMetricsStore,
  PostgresAppNotificationsStore,
  PostgresOAuthStateStore,
} from "./postgres-stores";

import type {
  GmailCheckpointStore,
  EncryptedConfigStore,
  SchedulerStateStore,
  LateralSyncHistoryStoreInterface,
  SyncWatermarkStoreInterface,
  LateralSourceDriveStateStoreInterface,
  HomeMetricsStoreInterface,
  AppNotificationsStoreInterface,
  OAuthStateStore,
} from "./interfaces";

// Singletons per process (stores are stateless / safe to reuse)
let _gmailCheckpoint: GmailCheckpointStore | null = null;
let _encryptedConfig: EncryptedConfigStore | null = null;
let _schedulerState: SchedulerStateStore | null = null;
let _lateralSyncHistory: LateralSyncHistoryStoreInterface | null = null;
let _syncWatermark: SyncWatermarkStoreInterface | null = null;
let _lateralSourceDriveState: LateralSourceDriveStateStoreInterface | null = null;
let _homeMetrics: HomeMetricsStoreInterface | null = null;
let _appNotifications: AppNotificationsStoreInterface | null = null;
let _oauthState: OAuthStateStore | null = null;

export function getGmailCheckpointStore(): GmailCheckpointStore {
  if (!_gmailCheckpoint) {
    _gmailCheckpoint = isPostgresMode()
      ? new PostgresGmailCheckpointStore()
      : new FileGmailCheckpointStore();
  }
  return _gmailCheckpoint;
}

export function getEncryptedConfigStore(): EncryptedConfigStore {
  if (!_encryptedConfig) {
    _encryptedConfig = isPostgresMode()
      ? new PostgresEncryptedConfigStore()
      : new FileEncryptedConfigStore();
  }
  return _encryptedConfig;
}

export function getSchedulerStateStore(): SchedulerStateStore {
  if (!_schedulerState) {
    _schedulerState = isPostgresMode()
      ? new PostgresSchedulerStateStore()
      : new FileSchedulerStateStore() as SchedulerStateStore;
  }
  return _schedulerState as SchedulerStateStore;
}

export function getLateralSyncHistoryStore(): LateralSyncHistoryStoreInterface {
  if (!_lateralSyncHistory) {
    _lateralSyncHistory = isPostgresMode()
      ? new PostgresLateralSyncHistoryStore()
      : new FileLateralSyncHistoryStore();
  }
  return _lateralSyncHistory;
}

export function getSyncWatermarkStore(): SyncWatermarkStoreInterface {
  if (!_syncWatermark) {
    _syncWatermark = isPostgresMode()
      ? new PostgresSyncWatermarkStore()
      : new FileSyncWatermarkStore();
  }
  return _syncWatermark;
}

export function getLateralSourceDriveStateStore(): LateralSourceDriveStateStoreInterface {
  if (!_lateralSourceDriveState) {
    _lateralSourceDriveState = isPostgresMode()
      ? new PostgresLateralSourceDriveStateStore()
      : new FileLateralSourceDriveStateStore();
  }
  return _lateralSourceDriveState;
}

export function getHomeMetricsStore(): HomeMetricsStoreInterface {
  if (!_homeMetrics) {
    _homeMetrics = isPostgresMode()
      ? new PostgresHomeMetricsStore()
      : new FileHomeMetricsStore();
  }
  return _homeMetrics;
}

export function getAppNotificationsStore(): AppNotificationsStoreInterface {
  if (!_appNotifications) {
    _appNotifications = isPostgresMode()
      ? new PostgresAppNotificationsStore()
      : new FileAppNotificationsStore();
  }
  return _appNotifications;
}

export function getOAuthStateStore(): OAuthStateStore {
  if (!_oauthState) {
    _oauthState = isPostgresMode()
      ? new PostgresOAuthStateStore()
      : new FileOAuthStateStore();
  }
  return _oauthState;
}

/** Reset all singletons (used in tests to switch modes). */
export function resetStoreFactory(): void {
  _gmailCheckpoint = null;
  _encryptedConfig = null;
  _schedulerState = null;
  _lateralSyncHistory = null;
  _syncWatermark = null;
  _lateralSourceDriveState = null;
  _homeMetrics = null;
  _appNotifications = null;
  _oauthState = null;
}
