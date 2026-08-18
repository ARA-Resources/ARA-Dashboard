import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isPostgresMode } from "@/lib/persistence/persistence-mode";
import { getAppNotificationsStore } from "@/lib/persistence/store-factory";
import type {
  AppNotification,
  AppNotificationKind,
  AppNotificationStore,
} from "@/types/notifications";

const STORE_PATH = path.join(process.cwd(), ".data", "app-notifications.json");
const MAX_NOTIFICATIONS = 50;

async function readStore(): Promise<AppNotificationStore> {
  try {
    const raw = (await fs.readFile(STORE_PATH, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as AppNotificationStore;
    if (!parsed || !Array.isArray(parsed.notifications)) {
      return { version: 1, notifications: [] };
    }
    return { version: 1, notifications: parsed.notifications };
  } catch {
    return { version: 1, notifications: [] };
  }
}

async function writeStore(store: AppNotificationStore) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

export async function listAppNotifications(limit = 20): Promise<AppNotification[]> {
  if (isPostgresMode()) return getAppNotificationsStore().list(limit);
  const store = await readStore();
  return store.notifications.slice(0, limit);
}

export async function countUnreadNotifications(): Promise<number> {
  if (isPostgresMode()) return getAppNotificationsStore().countUnread();
  const store = await readStore();
  return store.notifications.filter((item) => !item.read).length;
}

export async function pushAppNotification(input: {
  kind: AppNotificationKind;
  title: string;
  body: string;
  href?: string;
  meta?: Record<string, unknown>;
}): Promise<AppNotification> {
  if (isPostgresMode()) return getAppNotificationsStore().push(input);
  const store = await readStore();
  const notification: AppNotification = {
    id: randomUUID(),
    kind: input.kind,
    title: input.title,
    body: input.body,
    createdAt: new Date().toISOString(),
    read: false,
    href: input.href,
    meta: input.meta,
  };
  store.notifications = [notification, ...store.notifications].slice(
    0,
    MAX_NOTIFICATIONS
  );
  await writeStore(store);
  return notification;
}

export async function markNotificationRead(id: string): Promise<void> {
  if (isPostgresMode()) { await getAppNotificationsStore().markRead(id); return; }
  const store = await readStore();
  store.notifications = store.notifications.map((item) =>
    item.id === id ? { ...item, read: true } : item
  );
  await writeStore(store);
}

export async function markAllNotificationsRead(): Promise<void> {
  if (isPostgresMode()) { await getAppNotificationsStore().markAllRead(); return; }
  const store = await readStore();
  store.notifications = store.notifications.map((item) => ({
    ...item,
    read: true,
  }));
  await writeStore(store);
}
