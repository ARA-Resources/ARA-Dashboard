export type AppNotificationKind =
  | "dataset_sync_success"
  | "dataset_sync_partial"
  | "dataset_sync_failed"
  | "dataset_scheduler"
  | "info";

export interface AppNotification {
  id: string;
  kind: AppNotificationKind;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
  href?: string;
  meta?: Record<string, unknown>;
}

export interface AppNotificationStore {
  version: 1;
  notifications: AppNotification[];
}
