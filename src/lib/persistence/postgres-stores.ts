/**
 * PostgreSQL-backed persistence adapters.
 *
 * Only active when ARA_PERSISTENCE=postgres.
 * Uses the `postgres` package (sql tagged template, serverless-safe).
 *
 * Security:
 * - Encrypted values are stored as opaque strings (AES-256-GCM envelopes).
 * - No plaintext tokens, secrets, or keys are stored in the database.
 * - Encryption/decryption handled by existing encrypted-json-store utilities.
 *
 * Concurrency:
 * - Gmail checkpoint uses optimistic locking: UPDATE ... WHERE received_at_ms <= $prev
 *   so a concurrent worker that already advanced the checkpoint will not be overwritten.
 */

import { randomUUID } from "node:crypto";
import { getDbClient } from "./db-client";

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
  OAuthStatePayload,
} from "./interfaces";

import type { LateralGmailCheckpoint } from "@/types/lateral-gmail-checkpoint";
import type { LateralSchedulerConfig, LateralJobStatus, LateralJobTrigger } from "@/types/lateral-scheduler";
import type { LateralSyncHistoryEntry } from "@/types/lateral-sync-history";
import type { DatasetSyncWatermark } from "@/services/dataset/sync-watermark-store";
import type { AppNotification, AppNotificationKind } from "@/types/notifications";
import type {
  HomeWidgetsMetricsSnapshot,
  HomeUnitWidgetsMetrics,
  HomeWidgetsMetricsSource,
  MergeHomeUnitMetricsInput,
  isValidHomeUnitMetrics as _isValid,
} from "@/services/home/home-widgets-metrics-store";
import {
  isValidHomeUnitMetrics,
  HOME_WIDGETS_METRICS_STORE_VERSION,
} from "@/services/home/home-widgets-metrics-store";
import type { LateralSourceDriveState } from "@/services/lateral-processing/lateral-source-drive-state-store";
import type { BusinessUnitId } from "@/types/business-unit";
import type { ScheduleFrequency } from "@/types/dataset-schedule";
import { DEFAULT_LATERAL_TIMEZONE } from "@/types/lateral-processing-setup";

// ─── Gmail Checkpoint ────────────────────────────────────────────────────────

function rowToCheckpoint(row: Record<string, unknown> | undefined): LateralGmailCheckpoint {
  if (!row) {
    return {
      version: 1,
      messageId: null,
      attachmentId: null,
      receivedAt: null,
      receivedAtMs: null,
      attachmentFilename: null,
      driveFileId: null,
      processedAt: null,
      processingResult: null,
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    version: 1,
    messageId: typeof row.message_id === "string" ? row.message_id : null,
    attachmentId: typeof row.attachment_id === "string" ? row.attachment_id : null,
    receivedAt: row.received_at instanceof Date
      ? row.received_at.toISOString()
      : typeof row.received_at === "string" ? row.received_at : null,
    receivedAtMs: typeof row.received_at_ms === "bigint"
      ? Number(row.received_at_ms)
      : typeof row.received_at_ms === "number" ? row.received_at_ms : null,
    attachmentFilename: typeof row.attachment_file === "string" ? row.attachment_file : null,
    driveFileId: typeof row.drive_file_id === "string" ? row.drive_file_id : null,
    processedAt: row.processed_at instanceof Date
      ? row.processed_at.toISOString()
      : typeof row.processed_at === "string" ? row.processed_at : null,
    processingResult: row.result === "SUCCESS" ? "SUCCESS" : null,
    updatedAt: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : typeof row.updated_at === "string" ? row.updated_at : new Date().toISOString(),
  };
}

export class PostgresGmailCheckpointStore implements GmailCheckpointStore {
  async read(accountEmail = "default"): Promise<LateralGmailCheckpoint> {
    const sql = getDbClient();
    const rows = await sql<Record<string, unknown>[]>`
      SELECT * FROM gmail_checkpoint WHERE account_email = ${accountEmail} LIMIT 1
    `;
    return rowToCheckpoint(rows[0]);
  }

  /**
   * Atomic optimistic-locking update.
   *
   * Strategy: UPDATE ... WHERE received_at_ms IS NULL OR received_at_ms <= $prevMs
   *
   * If another worker already advanced the checkpoint to a NEWER receivedAtMs,
   * the WHERE clause will not match and rowCount=0, meaning this update is a no-op.
   * We then re-read the checkpoint and return it without overwriting the newer value.
   *
   * This prevents duplicate processing across concurrent Vercel instances.
   */
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
    if (input.processingResult !== "SUCCESS") {
      throw new Error(
        "Lateral Gmail checkpoint may only be written with processingResult=SUCCESS."
      );
    }

    const account = input.accountEmail ?? "default";
    const now = new Date();
    const processedAt = input.processedAt ? new Date(input.processedAt) : now;
    const receivedAt = new Date(input.receivedAt);
    const sql = getDbClient();

    // Ensure row exists first (idempotent upsert of empty row)
    await sql`
      INSERT INTO gmail_checkpoint (account_email)
      VALUES (${account})
      ON CONFLICT (account_email) DO NOTHING
    `;

    // Optimistic CAS: only advance if stored value is NULL or OLDER than incoming
    const result = await sql`
      UPDATE gmail_checkpoint
      SET
        message_id      = ${input.messageId},
        attachment_id   = ${input.attachmentId},
        received_at     = ${receivedAt},
        received_at_ms  = ${input.receivedAtMs},
        attachment_file = ${input.attachmentFilename},
        drive_file_id   = ${input.driveFileId},
        processed_at    = ${processedAt},
        result          = 'SUCCESS',
        updated_at      = ${now}
      WHERE account_email = ${account}
        AND (received_at_ms IS NULL OR received_at_ms < ${input.receivedAtMs}
             OR (received_at_ms = ${input.receivedAtMs} AND (message_id IS NULL OR message_id <= ${input.messageId})))
      RETURNING *
    `;

    if (result.length > 0) {
      return rowToCheckpoint(result[0] as Record<string, unknown>);
    }

    // Another worker already wrote a newer checkpoint — return current stored value
    return this.read(account);
  }
}

// ─── Encrypted Config ─────────────────────────────────────────────────────────

export class PostgresEncryptedConfigStore implements EncryptedConfigStore {
  async readRawEnvelope(key: string): Promise<string | null> {
    const sql = getDbClient();
    const rows = await sql<{ encrypted_value: string }[]>`
      SELECT encrypted_value FROM app_config WHERE key = ${key} LIMIT 1
    `;
    return rows[0]?.encrypted_value ?? null;
  }

  async writeRawEnvelope(key: string, envelope: string): Promise<void> {
    const sql = getDbClient();
    await sql`
      INSERT INTO app_config (key, encrypted_value, updated_at)
      VALUES (${key}, ${envelope}, NOW())
      ON CONFLICT (key) DO UPDATE
        SET encrypted_value = EXCLUDED.encrypted_value,
            updated_at      = EXCLUDED.updated_at
    `;
  }

  async deleteKey(key: string): Promise<void> {
    const sql = getDbClient();
    await sql`DELETE FROM app_config WHERE key = ${key}`;
  }
}

// ─── Scheduler State ─────────────────────────────────────────────────────────

function normalizeFrequency(v: unknown): ScheduleFrequency {
  if (v === "hourly" || v === "daily" || v === "weekdays" || v === "weekly" || v === "custom") {
    return v;
  }
  return "daily";
}

function normalizeJobStatus(v: unknown): LateralJobStatus | null {
  if (v === "success" || v === "partial" || v === "failed") return v;
  return null;
}

function normalizeJobTrigger(v: unknown): LateralJobTrigger | null {
  if (v === "scheduler" || v === "manual") return v;
  return null;
}

function rowToLateralSchedulerConfig(row: Record<string, unknown>): LateralSchedulerConfig {
  return {
    version: 1,
    frequency: normalizeFrequency(row.frequency),
    syncTime: typeof row.sync_time === "string" ? row.sync_time : "07:00",
    dayOfWeek: typeof row.day_of_week === "number" ? row.day_of_week : 1,
    customDays: Array.isArray(row.custom_days) ? (row.custom_days as number[]) : [1, 2, 3, 4, 5],
    customTimes: Array.isArray(row.custom_times) ? (row.custom_times as string[]) : ["09:00"],
    timezone: typeof row.timezone === "string" ? row.timezone : DEFAULT_LATERAL_TIMEZONE,
    enabled: row.enabled === true,
    paused: row.paused === true,
    updatedAt: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : typeof row.updated_at === "string" ? row.updated_at : new Date().toISOString(),
    lastRunAt: row.last_run_at instanceof Date
      ? row.last_run_at.toISOString()
      : typeof row.last_run_at === "string" ? row.last_run_at : null,
    lastRunStatus: normalizeJobStatus(row.last_run_status),
    lastRunMessage: typeof row.last_run_message === "string" ? row.last_run_message : null,
    lastDurationMs: typeof row.last_duration_ms === "number" ? row.last_duration_ms : null,
    lastTrigger: normalizeJobTrigger(row.last_trigger),
  };
}

export class PostgresSchedulerStateStore implements SchedulerStateStore {
  async readLateral(): Promise<LateralSchedulerConfig> {
    const sql = getDbClient();
    await sql`INSERT INTO lateral_scheduler_state DEFAULT VALUES ON CONFLICT DO NOTHING`;
    const rows = await sql<Record<string, unknown>[]>`
      SELECT * FROM lateral_scheduler_state ORDER BY id LIMIT 1
    `;
    if (!rows[0]) {
      // Return safe default
      return {
        version: 1,
        frequency: "daily",
        syncTime: "07:00",
        dayOfWeek: 1,
        customDays: [1, 2, 3, 4, 5],
        customTimes: ["09:00"],
        timezone: DEFAULT_LATERAL_TIMEZONE,
        enabled: true,
        paused: false,
        updatedAt: new Date().toISOString(),
        lastRunAt: null,
        lastRunStatus: null,
        lastRunMessage: null,
        lastDurationMs: null,
        lastTrigger: null,
      };
    }
    return rowToLateralSchedulerConfig(rows[0]);
  }

  async writeLateral(partial: Partial<LateralSchedulerConfig>): Promise<LateralSchedulerConfig> {
    const prior = await this.readLateral();
    const config: LateralSchedulerConfig = { ...prior, ...partial };
    const sql = getDbClient();
    await sql`
      UPDATE lateral_scheduler_state SET
        frequency        = ${config.frequency},
        sync_time        = ${config.syncTime},
        day_of_week      = ${config.dayOfWeek},
        custom_days      = ${sql.json(config.customDays as never)},
        custom_times     = ${sql.json(config.customTimes as never)},
        timezone         = ${config.timezone},
        enabled          = ${config.enabled},
        paused           = ${config.paused},
        last_run_at      = ${config.lastRunAt ? new Date(config.lastRunAt) : null},
        last_run_status  = ${config.lastRunStatus},
        last_run_message = ${config.lastRunMessage},
        last_duration_ms = ${config.lastDurationMs},
        last_trigger     = ${config.lastTrigger},
        updated_at       = NOW()
      WHERE id = (SELECT id FROM lateral_scheduler_state ORDER BY id LIMIT 1)
    `;
    return config;
  }
}

// ─── Lateral Sync History ────────────────────────────────────────────────────

function rowToSyncEntry(row: Record<string, unknown>): LateralSyncHistoryEntry {
  return {
    id: typeof row.id === "string" ? row.id : randomUUID(),
    syncTime: row.sync_time instanceof Date
      ? row.sync_time.toISOString()
      : typeof row.sync_time === "string" ? row.sync_time : new Date().toISOString(),
    sourceEmail: typeof row.source_email === "string" ? row.source_email : "—",
    originalFilename: typeof row.original_filename === "string" ? row.original_filename : "—",
    googleDriveFileId: typeof row.drive_file_id === "string" ? row.drive_file_id : "—",
    rowsImported: typeof row.rows_imported === "number" ? row.rows_imported : 0,
    newCount: typeof row.new_count === "number" ? row.new_count : 0,
    activeCount: typeof row.active_count === "number" ? row.active_count : 0,
    reopenCount: typeof row.reopen_count === "number" ? row.reopen_count : 0,
    closedCount: typeof row.closed_count === "number" ? row.closed_count : 0,
    result: row.result === "Success" ? "Success" : "Failed",
    error: typeof row.error === "string" ? row.error : null,
    trigger: (row.trigger === "scheduler" || row.trigger === "manual") ? row.trigger : "manual",
    durationMs: typeof row.duration_ms === "number" ? row.duration_ms : 0,
  };
}

export class PostgresLateralSyncHistoryStore implements LateralSyncHistoryStoreInterface {
  async list(limit = 100): Promise<LateralSyncHistoryEntry[]> {
    const sql = getDbClient();
    const cap = Math.max(1, Math.min(500, limit));
    const rows = await sql<Record<string, unknown>[]>`
      SELECT * FROM lateral_sync_history ORDER BY sync_time DESC LIMIT ${cap}
    `;
    return rows.map(rowToSyncEntry);
  }

  async append(input: Omit<LateralSyncHistoryEntry, "id">): Promise<LateralSyncHistoryEntry> {
    const sql = getDbClient();
    const id = randomUUID();
    await sql`
      INSERT INTO lateral_sync_history
        (id, sync_time, source_email, original_filename, drive_file_id,
         rows_imported, new_count, active_count, reopen_count, closed_count,
         result, error, trigger, duration_ms)
      VALUES
        (${id}, ${new Date(input.syncTime)}, ${input.sourceEmail || "—"},
         ${input.originalFilename || "—"}, ${input.googleDriveFileId || "—"},
         ${input.rowsImported}, ${input.newCount}, ${input.activeCount},
         ${input.reopenCount}, ${input.closedCount},
         ${input.result}, ${input.error ?? null}, ${input.trigger},
         ${input.durationMs})
    `;
    return { id, ...input };
  }
}

// ─── Sync Watermark ──────────────────────────────────────────────────────────

export class PostgresSyncWatermarkStore implements SyncWatermarkStoreInterface {
  async read(): Promise<DatasetSyncWatermark> {
    const sql = getDbClient();
    await sql`INSERT INTO sync_watermark DEFAULT VALUES ON CONFLICT DO NOTHING`;
    const rows = await sql<Record<string, unknown>[]>`
      SELECT * FROM sync_watermark ORDER BY id LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return { version: 1, lastSuccessfulSyncAt: null, lastSuccessfulSyncAtMs: null, lastTrigger: null, updatedAt: new Date().toISOString() };
    }
    const at = row.last_successful_sync_at instanceof Date
      ? row.last_successful_sync_at.toISOString()
      : typeof row.last_successful_sync_at === "string" ? row.last_successful_sync_at : null;
    const ms = typeof row.last_successful_sync_ms === "bigint"
      ? Number(row.last_successful_sync_ms)
      : typeof row.last_successful_sync_ms === "number" ? row.last_successful_sync_ms : null;
    const trigger = row.last_trigger === "scheduler" || row.last_trigger === "manual" || row.last_trigger === "api"
      ? row.last_trigger as "scheduler" | "manual" | "api"
      : null;
    return {
      version: 1,
      lastSuccessfulSyncAt: at,
      lastSuccessfulSyncAtMs: ms,
      lastTrigger: trigger,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date().toISOString(),
    };
  }

  async write(
    partial: Partial<Pick<DatasetSyncWatermark, "lastSuccessfulSyncAt" | "lastSuccessfulSyncAtMs" | "lastTrigger">>
  ): Promise<DatasetSyncWatermark> {
    const prior = await this.read();
    const at = partial.lastSuccessfulSyncAt ?? prior.lastSuccessfulSyncAt ?? null;
    const ms = partial.lastSuccessfulSyncAtMs ?? (at ? Date.parse(at) : null) ?? prior.lastSuccessfulSyncAtMs;
    const trigger = partial.lastTrigger ?? prior.lastTrigger ?? null;
    const sql = getDbClient();
    await sql`
      UPDATE sync_watermark SET
        last_successful_sync_at = ${at ? new Date(at) : null},
        last_successful_sync_ms = ${ms},
        last_trigger            = ${trigger},
        updated_at              = NOW()
      WHERE id = (SELECT id FROM sync_watermark ORDER BY id LIMIT 1)
    `;
    return {
      version: 1,
      lastSuccessfulSyncAt: at,
      lastSuccessfulSyncAtMs: ms && Number.isFinite(ms) ? ms : null,
      lastTrigger: trigger,
      updatedAt: new Date().toISOString(),
    };
  }
}

// ─── Lateral Source Drive State ──────────────────────────────────────────────

function rowToDriveState(row: Record<string, unknown>): LateralSourceDriveState {
  const current = typeof row.current_drive_file_id === "string" && row.current_drive_file_id
    ? {
        driveFileId: row.current_drive_file_id,
        fileName: typeof row.current_file_name === "string" ? row.current_file_name : "",
        messageId: typeof row.current_message_id === "string" ? row.current_message_id : null,
        receivedAt: row.current_received_at instanceof Date
          ? row.current_received_at.toISOString()
          : typeof row.current_received_at === "string" ? row.current_received_at : null,
        uploadedAt: row.current_uploaded_at instanceof Date
          ? row.current_uploaded_at.toISOString()
          : typeof row.current_uploaded_at === "string"
            ? row.current_uploaded_at
            : new Date().toISOString(),
      }
    : null;
  return {
    version: 1,
    currentSource: current,
    pendingCleanupFileIds: Array.isArray(row.pending_cleanup_file_ids)
      ? (row.pending_cleanup_file_ids as string[]).filter((id): id is string => typeof id === "string")
      : [],
    updatedAt: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : typeof row.updated_at === "string" ? row.updated_at : new Date().toISOString(),
  };
}

export class PostgresLateralSourceDriveStateStore implements LateralSourceDriveStateStoreInterface {
  async read(): Promise<LateralSourceDriveState> {
    const sql = getDbClient();
    await sql`INSERT INTO lateral_source_drive_state DEFAULT VALUES ON CONFLICT DO NOTHING`;
    const rows = await sql<Record<string, unknown>[]>`
      SELECT * FROM lateral_source_drive_state ORDER BY id LIMIT 1
    `;
    if (!rows[0]) return { version: 1, currentSource: null, pendingCleanupFileIds: [], updatedAt: new Date().toISOString() };
    return rowToDriveState(rows[0]);
  }

  async write(state: LateralSourceDriveState): Promise<LateralSourceDriveState> {
    const sql = getDbClient();
    const cleanupIds = Array.from(
      new Set(
        (state.pendingCleanupFileIds ?? []).filter(
          (id) => id && (!state.currentSource || id !== state.currentSource.driveFileId)
        )
      )
    );
    const src = state.currentSource;
    await sql`
      UPDATE lateral_source_drive_state SET
        current_drive_file_id    = ${src?.driveFileId ?? null},
        current_file_name        = ${src?.fileName ?? null},
        current_message_id       = ${src?.messageId ?? null},
        current_received_at      = ${src?.receivedAt ? new Date(src.receivedAt) : null},
        current_uploaded_at      = ${src?.uploadedAt ? new Date(src.uploadedAt) : null},
        pending_cleanup_file_ids = ${sql.json(cleanupIds as never)},
        updated_at               = NOW()
      WHERE id = (SELECT id FROM lateral_source_drive_state ORDER BY id LIMIT 1)
    `;
    return { ...state, pendingCleanupFileIds: cleanupIds, updatedAt: new Date().toISOString() };
  }
}

// ─── Home Metrics ─────────────────────────────────────────────────────────────

const BU_IDS: BusinessUnitId[] = ["lateral", "executive", "consulting"];

function rowToUnit(row: Record<string, unknown>): HomeUnitWidgetsMetrics {
  const normalizeSource = (v: unknown): HomeWidgetsMetricsSource => {
    if (v === "pipeline" || v === "bootstrap" || v === "manual" || v === "drive-xlsm") return v;
    return "unknown";
  };
  return {
    totals: typeof row.totals === "number" ? row.totals : 0,
    active: typeof row.active === "number" ? row.active : 0,
    posted: typeof row.posted === "number" ? row.posted : 0,
    fresh: typeof row.fresh === "number" ? row.fresh : 0,
    fileName: typeof row.file_name === "string" ? row.file_name : "",
    mtimeMs: typeof row.mtime_ms === "bigint" ? Number(row.mtime_ms) : typeof row.mtime_ms === "number" ? row.mtime_ms : 0,
    source: normalizeSource(row.source),
    computedAt: row.computed_at instanceof Date
      ? row.computed_at.toISOString()
      : typeof row.computed_at === "string" ? row.computed_at : "",
    error: typeof row.error === "string" ? row.error : null,
  };
}

export class PostgresHomeMetricsStore implements HomeMetricsStoreInterface {
  async readSnapshot(): Promise<HomeWidgetsMetricsSnapshot> {
    const sql = getDbClient();
    const rows = await sql<Record<string, unknown>[]>`
      SELECT * FROM home_metrics WHERE business_unit_id = ANY(${BU_IDS})
    `;
    const units: HomeWidgetsMetricsSnapshot["units"] = {};
    for (const row of rows) {
      const id = row.business_unit_id as BusinessUnitId;
      units[id] = rowToUnit(row);
    }
    return {
      version: HOME_WIDGETS_METRICS_STORE_VERSION,
      updatedAt: new Date().toISOString(),
      units,
    };
  }

  async writeSnapshot(snapshot: HomeWidgetsMetricsSnapshot): Promise<HomeWidgetsMetricsSnapshot> {
    const sql = getDbClient();
    for (const id of BU_IDS) {
      const unit = snapshot.units[id];
      if (!unit) continue;
      await sql`
        INSERT INTO home_metrics (business_unit_id, totals, active, posted, fresh, file_name, mtime_ms, source, computed_at, error)
        VALUES (${id}, ${unit.totals}, ${unit.active}, ${unit.posted}, ${unit.fresh},
                ${unit.fileName}, ${unit.mtimeMs}, ${unit.source},
                ${unit.computedAt ? new Date(unit.computedAt) : null}, ${unit.error})
        ON CONFLICT (business_unit_id) DO UPDATE SET
          totals      = EXCLUDED.totals,
          active      = EXCLUDED.active,
          posted      = EXCLUDED.posted,
          fresh       = EXCLUDED.fresh,
          file_name   = EXCLUDED.file_name,
          mtime_ms    = EXCLUDED.mtime_ms,
          source      = EXCLUDED.source,
          computed_at = EXCLUDED.computed_at,
          error       = EXCLUDED.error,
          updated_at  = NOW()
      `;
    }
    return snapshot;
  }

  async mergeUnit(
    businessUnitId: BusinessUnitId,
    incoming: MergeHomeUnitMetricsInput
  ): Promise<HomeWidgetsMetricsSnapshot> {
    const prior = await this.readSnapshot();
    const previous = prior.units[businessUnitId];
    const candidate: HomeUnitWidgetsMetrics = {
      totals: incoming.totals,
      active: incoming.active,
      posted: incoming.posted,
      fresh: incoming.fresh,
      fileName: incoming.fileName,
      mtimeMs: incoming.mtimeMs,
      source: incoming.source,
      computedAt: incoming.computedAt,
      error: incoming.error === undefined || incoming.error === null ? null : String(incoming.error),
    };
    let toWrite: HomeUnitWidgetsMetrics;
    if (isValidHomeUnitMetrics(candidate)) {
      const incomingEmpty =
        candidate.totals === 0 &&
        candidate.active === 0 &&
        candidate.posted === 0 &&
        candidate.fresh === 0;
      const previousPopulated =
        previous != null &&
        isValidHomeUnitMetrics(previous) &&
        (previous.totals > 0 ||
          previous.active > 0 ||
          previous.posted > 0 ||
          previous.fresh > 0);
      toWrite =
        incomingEmpty && previousPopulated && previous != null
          ? previous
          : candidate;
    } else if (previous != null && isValidHomeUnitMetrics(previous)) {
      toWrite = previous;
    } else {
      toWrite = previous ?? candidate;
    }

    const snapshot: HomeWidgetsMetricsSnapshot = {
      ...prior,
      units: { ...prior.units, [businessUnitId]: toWrite },
    };
    return this.writeSnapshot(snapshot);
  }
}

// ─── App Notifications ───────────────────────────────────────────────────────

function rowToNotification(row: Record<string, unknown>): AppNotification {
  return {
    id: typeof row.id === "string" ? row.id : randomUUID(),
    kind: (row.kind as AppNotificationKind) ?? "info",
    title: typeof row.title === "string" ? row.title : "",
    body: typeof row.body === "string" ? row.body : "",
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : typeof row.created_at === "string" ? row.created_at : new Date().toISOString(),
    read: row.read === true,
    href: typeof row.href === "string" ? row.href : undefined,
    meta: row.meta && typeof row.meta === "object" ? row.meta as Record<string, unknown> : undefined,
  };
}

const MAX_NOTIFICATIONS = 50;

export class PostgresAppNotificationsStore implements AppNotificationsStoreInterface {
  async list(limit = 20): Promise<AppNotification[]> {
    const sql = getDbClient();
    const cap = Math.max(1, Math.min(MAX_NOTIFICATIONS, limit));
    const rows = await sql<Record<string, unknown>[]>`
      SELECT * FROM app_notifications ORDER BY created_at DESC LIMIT ${cap}
    `;
    return rows.map(rowToNotification);
  }

  async countUnread(): Promise<number> {
    const sql = getDbClient();
    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*) as count FROM app_notifications WHERE read = FALSE
    `;
    return parseInt(rows[0]?.count ?? "0", 10);
  }

  async push(input: {
    kind: AppNotificationKind;
    title: string;
    body: string;
    href?: string;
    meta?: Record<string, unknown>;
  }): Promise<AppNotification> {
    const sql = getDbClient();
    const id = randomUUID();
    const now = new Date();
    await sql`
      INSERT INTO app_notifications (id, kind, title, body, href, meta, read, created_at)
      VALUES (${id}, ${input.kind}, ${input.title}, ${input.body},
              ${input.href ?? null}, ${input.meta ? sql.json(input.meta as never) : null},
              FALSE, ${now})
    `;
    // Trim to MAX_NOTIFICATIONS
    await sql`
      DELETE FROM app_notifications
      WHERE id IN (
        SELECT id FROM app_notifications
        ORDER BY created_at ASC
        OFFSET ${MAX_NOTIFICATIONS}
      )
    `;
    return {
      id,
      kind: input.kind,
      title: input.title,
      body: input.body,
      createdAt: now.toISOString(),
      read: false,
      href: input.href,
      meta: input.meta,
    };
  }

  async markRead(id: string): Promise<void> {
    const sql = getDbClient();
    await sql`UPDATE app_notifications SET read = TRUE WHERE id = ${id}`;
  }

  async markAllRead(): Promise<void> {
    const sql = getDbClient();
    await sql`UPDATE app_notifications SET read = TRUE WHERE read = FALSE`;
  }

  async delete(id: string): Promise<void> {
    const sql = getDbClient();
    await sql`DELETE FROM app_notifications WHERE id = ${id}`;
  }
}

// ─── OAuth State ─────────────────────────────────────────────────────────────

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class PostgresOAuthStateStore implements OAuthStateStore {
  async save(state: string, payload: OAuthStatePayload): Promise<void> {
    const sql = getDbClient();
    const expiresAt = new Date(payload.expiresAt);
    // Each state token is its own row — concurrent flows never collide.
    await sql`
      INSERT INTO oauth_state (state_token, expected_email, expires_at)
      VALUES (${state}, ${payload.expectedEmail}, ${expiresAt})
      ON CONFLICT (state_token) DO NOTHING
    `;
    // Opportunistically purge tokens that expired more than an hour ago.
    await sql`
      DELETE FROM oauth_state
      WHERE expires_at < NOW() - INTERVAL '1 hour'
    `;
  }

  async consume(state: string): Promise<OAuthStatePayload | null> {
    const sql = getDbClient();
    // Delete and return atomically — single-use guarantee.
    const rows = await sql<{ expected_email: string; expires_at: Date }[]>`
      DELETE FROM oauth_state
      WHERE state_token = ${state}
        AND expires_at > NOW()
      RETURNING expected_email, expires_at
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      expectedEmail: row.expected_email,
      expiresAt: row.expires_at.toISOString(),
    };
  }
}

// Exported so scripts/_run-migrate.mjs can reference the TTL value.
export { OAUTH_STATE_TTL_MS };
