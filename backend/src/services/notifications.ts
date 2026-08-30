/**
 * Stage 11: App notifications from PostgreSQL `app_notifications` only.
 *
 * Ports Next postgres-mode list / countUnread / markRead / markAllRead.
 * Does NOT port push/create, file store, or notification producers.
 */
import { queryRows } from "../db.js";
import type {
  AppNotification,
  AppNotificationKind,
  NotificationsListResponse,
} from "../types/notifications.js";

const LIST_LIMIT = 30;
const MAX_NOTIFICATIONS = 50;

function rowToNotification(row: Record<string, unknown>): AppNotification {
  const createdAt =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : typeof row.created_at === "string"
        ? row.created_at
        : new Date().toISOString();

  const notification: AppNotification = {
    id: typeof row.id === "string" ? row.id : String(row.id ?? ""),
    kind: (typeof row.kind === "string" ? row.kind : "info") as AppNotificationKind,
    title: typeof row.title === "string" ? row.title : "",
    body: typeof row.body === "string" ? row.body : "",
    createdAt,
    read: row.read === true,
  };

  if (typeof row.href === "string") {
    notification.href = row.href;
  }
  if (row.meta && typeof row.meta === "object" && !Array.isArray(row.meta)) {
    notification.meta = row.meta as Record<string, unknown>;
  }

  return notification;
}

export async function listAppNotifications(
  limit = LIST_LIMIT
): Promise<AppNotification[]> {
  const cap = Math.max(1, Math.min(MAX_NOTIFICATIONS, limit));
  const rows = await queryRows<Record<string, unknown>>(
    `SELECT id, kind, title, body, href, meta, read, created_at
     FROM app_notifications
     ORDER BY created_at DESC
     LIMIT $1`,
    [cap]
  );
  return rows.map(rowToNotification);
}

export async function countUnreadNotifications(): Promise<number> {
  const rows = await queryRows<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM app_notifications
     WHERE read = FALSE`
  );
  return Number.parseInt(rows[0]?.count ?? "0", 10);
}

export async function getNotificationsPayload(): Promise<NotificationsListResponse> {
  const [notifications, unreadCount] = await Promise.all([
    listAppNotifications(LIST_LIMIT),
    countUnreadNotifications(),
  ]);
  return { notifications, unreadCount };
}

export async function markNotificationRead(id: string): Promise<void> {
  await queryRows(
    `UPDATE app_notifications
     SET read = TRUE
     WHERE id = $1`,
    [id]
  );
}

export async function markAllNotificationsRead(): Promise<void> {
  await queryRows(
    `UPDATE app_notifications
     SET read = TRUE
     WHERE read = FALSE`
  );
}
