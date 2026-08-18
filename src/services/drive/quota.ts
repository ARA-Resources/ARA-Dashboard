import { getAuthorizedGmailClient } from "@/services/gmail/oauth";

export interface DriveQuotaSnapshot {
  available: boolean;
  email: string | null;
  limitBytes: number | null;
  usageBytes: number | null;
  usageInDriveBytes: number | null;
  usageInDriveTrashBytes: number | null;
  percentUsed: number | null;
  error?: string;
}

/**
 * Read Google Drive storage quota for the connected account.
 */
export async function fetchDriveQuota(): Promise<DriveQuotaSnapshot> {
  try {
    const { drive, auth } = await getAuthorizedGmailClient();
    const about = await drive.about.get({
      fields: "user,storageQuota",
    });
    const quota = about.data.storageQuota;
    const limit = quota?.limit != null ? Number(quota.limit) : null;
    const usage = quota?.usage != null ? Number(quota.usage) : null;
    const usageInDrive =
      quota?.usageInDrive != null ? Number(quota.usageInDrive) : null;
    const usageInDriveTrash =
      quota?.usageInDriveTrash != null ? Number(quota.usageInDriveTrash) : null;

    const percentUsed =
      limit != null && limit > 0 && usage != null
        ? Math.min(100, (usage / limit) * 100)
        : null;

    return {
      available: true,
      email: about.data.user?.emailAddress ?? auth.email ?? null,
      limitBytes: Number.isFinite(limit) ? limit : null,
      usageBytes: Number.isFinite(usage) ? usage : null,
      usageInDriveBytes: Number.isFinite(usageInDrive) ? usageInDrive : null,
      usageInDriveTrashBytes: Number.isFinite(usageInDriveTrash)
        ? usageInDriveTrash
        : null,
      percentUsed,
    };
  } catch (error) {
    return {
      available: false,
      email: null,
      limitBytes: null,
      usageBytes: null,
      usageInDriveBytes: null,
      usageInDriveTrashBytes: null,
      percentUsed: null,
      error:
        error instanceof Error
          ? error.message
          : "Failed to read Google Drive quota.",
    };
  }
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
