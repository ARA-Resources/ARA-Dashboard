import { randomUUID } from "node:crypto";
import { queryRows } from "../db.js";
import type { LateralSyncHistoryEntry } from "../types/lateral-sync-history.js";

interface LateralSyncHistoryRow {
  id?: unknown;
  sync_time?: unknown;
  source_email?: unknown;
  original_filename?: unknown;
  drive_file_id?: unknown;
  rows_imported?: unknown;
  new_count?: unknown;
  active_count?: unknown;
  reopen_count?: unknown;
  closed_count?: unknown;
  result?: unknown;
  error?: unknown;
  trigger?: unknown;
  duration_ms?: unknown;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rowToSyncEntry(row: LateralSyncHistoryRow): LateralSyncHistoryEntry {
  return {
    id: typeof row.id === "string" ? row.id : randomUUID(),
    syncTime:
      row.sync_time instanceof Date
        ? row.sync_time.toISOString()
        : typeof row.sync_time === "string"
          ? row.sync_time
          : new Date().toISOString(),
    sourceEmail: typeof row.source_email === "string" ? row.source_email : "—",
    originalFilename:
      typeof row.original_filename === "string" ? row.original_filename : "—",
    googleDriveFileId:
      typeof row.drive_file_id === "string" ? row.drive_file_id : "—",
    rowsImported: asFiniteNumber(row.rows_imported) ?? 0,
    newCount: asFiniteNumber(row.new_count) ?? 0,
    activeCount: asFiniteNumber(row.active_count) ?? 0,
    reopenCount: asFiniteNumber(row.reopen_count) ?? 0,
    closedCount: asFiniteNumber(row.closed_count) ?? 0,
    result: row.result === "Success" ? "Success" : "Failed",
    error: typeof row.error === "string" ? row.error : null,
    trigger:
      row.trigger === "scheduler" || row.trigger === "manual"
        ? row.trigger
        : "manual",
    durationMs: asFiniteNumber(row.duration_ms) ?? 0,
  };
}

export async function listLateralSyncHistory(
  limit: number
): Promise<LateralSyncHistoryEntry[]> {
  const cap = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = await queryRows<LateralSyncHistoryRow>(
    "SELECT * FROM lateral_sync_history ORDER BY sync_time DESC LIMIT $1",
    [cap]
  );
  return rows.map(rowToSyncEntry);
}
