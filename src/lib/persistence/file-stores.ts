/**
 * File-backed persistence adapters.
 *
 * These are thin wrappers that delegate to the existing .data/ JSON store
 * implementations. They implement the domain interfaces so the store factory
 * can return them when ARA_PERSISTENCE=file.
 *
 * DO NOT change any business logic here.
 * The only purpose is interface conformance.
 */

import {
  readLateralGmailCheckpoint,
  advanceLateralGmailCheckpoint,
} from "@/services/lateral-processing/lateral-gmail-checkpoint-store";
import {
  readHomeWidgetsMetricsSnapshot,
  writeHomeWidgetsMetricsSnapshot,
  mergeHomeUnitWidgetsMetrics,
} from "@/services/home/home-widgets-metrics-store";
import {
  listLateralSyncHistory,
  appendLateralSyncHistory,
} from "@/services/lateral-processing/lateral-sync-history-store";
import {
  readSyncWatermark,
  writeSyncWatermark,
} from "@/services/dataset/sync-watermark-store";
import {
  readLateralSourceDriveState,
  writeLateralSourceDriveState,
} from "@/services/lateral-processing/lateral-source-drive-state-store";
import {
  listAppNotifications,
  countUnreadNotifications,
  pushAppNotification,
  markNotificationRead,
  markAllNotificationsRead,
} from "@/services/dataset/notifications-store";
import {
  readEncryptedJson,
  writeEncryptedJson,
  deleteEncryptedJson,
} from "@/services/dataset/encrypted-json-store";
import {
  readLateralSchedulerConfig,
  writeLateralSchedulerConfig,
} from "@/services/lateral-processing/lateral-scheduler";

import type {
  GmailCheckpointStore,
  EncryptedConfigStore,
  SchedulerStateStore,
  LateralSyncHistoryStoreInterface,
  SyncWatermarkStoreInterface,
  LateralSourceDriveStateStoreInterface,
  HomeMetricsStoreInterface,
  AppNotificationsStoreInterface,
} from "./interfaces";

import type { LateralGmailCheckpoint } from "@/types/lateral-gmail-checkpoint";
import type { BusinessUnitId } from "@/types/business-unit";
import type { MergeHomeUnitMetricsInput } from "@/services/home/home-widgets-metrics-store";
import type { AppNotificationKind } from "@/types/notifications";

// ─── Gmail Checkpoint ────────────────────────────────────────────────────────

export class FileGmailCheckpointStore implements GmailCheckpointStore {
  async read(_accountEmail?: string): Promise<LateralGmailCheckpoint> {
    return readLateralGmailCheckpoint();
  }

  async advance(input: {
    messageId: string;
    attachmentId: string;
    receivedAt: string;
    receivedAtMs: number;
    attachmentFilename: string;
    driveFileId: string;
    processedAt?: string;
    processingResult: "SUCCESS";
    accountEmail?: string;
  }): Promise<LateralGmailCheckpoint> {
    return advanceLateralGmailCheckpoint(input);
  }
}

// ─── Encrypted Config ─────────────────────────────────────────────────────────

export class FileEncryptedConfigStore implements EncryptedConfigStore {
  async readRawEnvelope(key: string): Promise<string | null> {
    // The file store reads per-file. key maps to fileName.
    // We re-use encrypted-json-store directly to read the raw envelope.
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const filePath = path.join(process.cwd(), ".data", key);
      return await fs.readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }

  async writeRawEnvelope(key: string, envelope: string): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = path.join(process.cwd(), ".data");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, key), envelope, "utf8");
  }

  async deleteKey(key: string): Promise<void> {
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      await fs.unlink(path.join(process.cwd(), ".data", key));
    } catch {
      // ignore missing
    }
  }
}

// ─── Scheduler State ─────────────────────────────────────────────────────────

export class FileSchedulerStateStore implements SchedulerStateStore {
  async readLateral() {
    return readLateralSchedulerConfig();
  }

  async writeLateral(config: Partial<import("@/types/lateral-scheduler").LateralSchedulerConfig>) {
    return writeLateralSchedulerConfig(config);
  }
}

// ─── Lateral Sync History ────────────────────────────────────────────────────

export class FileLateralSyncHistoryStore implements LateralSyncHistoryStoreInterface {
  async list(limit?: number) {
    return listLateralSyncHistory(limit);
  }

  async append(entry: Parameters<LateralSyncHistoryStoreInterface["append"]>[0]) {
    return appendLateralSyncHistory(entry);
  }
}

// ─── Sync Watermark ──────────────────────────────────────────────────────────

export class FileSyncWatermarkStore implements SyncWatermarkStoreInterface {
  async read() {
    return readSyncWatermark();
  }

  async write(partial: Parameters<SyncWatermarkStoreInterface["write"]>[0]) {
    return writeSyncWatermark(partial);
  }
}

// ─── Lateral Source Drive State ──────────────────────────────────────────────

export class FileLateralSourceDriveStateStore
  implements LateralSourceDriveStateStoreInterface
{
  async read() {
    return readLateralSourceDriveState();
  }

  async write(state: Parameters<LateralSourceDriveStateStoreInterface["write"]>[0]) {
    return writeLateralSourceDriveState(state);
  }
}

// ─── Home Metrics ─────────────────────────────────────────────────────────────

export class FileHomeMetricsStore implements HomeMetricsStoreInterface {
  async readSnapshot() {
    return readHomeWidgetsMetricsSnapshot();
  }

  async writeSnapshot(snapshot: Parameters<HomeMetricsStoreInterface["writeSnapshot"]>[0]) {
    return writeHomeWidgetsMetricsSnapshot(snapshot);
  }

  async mergeUnit(
    businessUnitId: BusinessUnitId,
    incoming: MergeHomeUnitMetricsInput
  ) {
    return mergeHomeUnitWidgetsMetrics(businessUnitId, incoming);
  }
}

// ─── App Notifications ───────────────────────────────────────────────────────

export class FileAppNotificationsStore implements AppNotificationsStoreInterface {
  async list(limit?: number) {
    return listAppNotifications(limit);
  }

  async countUnread() {
    return countUnreadNotifications();
  }

  async push(input: {
    kind: AppNotificationKind;
    title: string;
    body: string;
    href?: string;
    meta?: Record<string, unknown>;
  }) {
    return pushAppNotification(input);
  }

  async markRead(id: string) {
    return markNotificationRead(id);
  }

  async markAllRead() {
    return markAllNotificationsRead();
  }

  async delete(id: string): Promise<void> {
    // File store does not expose delete — notifications expire via max-size trim
    void id;
  }
}
