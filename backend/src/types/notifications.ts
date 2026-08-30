export type AppNotificationKind =
  | "dataset_sync_success"
  | "dataset_sync_partial"
  | "dataset_sync_failed"
  | "dataset_scheduler"
  | "info"
  | string;

export type AppNotification = {
  id: string;
  kind: AppNotificationKind;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
  href?: string;
  meta?: Record<string, unknown>;
};

export type NotificationsListResponse = {
  notifications: AppNotification[];
  unreadCount: number;
};
