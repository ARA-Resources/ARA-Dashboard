import { forgetGmailAttachments } from "@/services/gmail/scan";
import { getSyncHistoryEntry } from "@/services/dataset/sync-history-store";
import { triggerDatasetSyncNow } from "@/services/dataset/scheduler";
import { pushAppNotification } from "@/services/dataset/notifications-store";
import type { AutomatedSyncOutcome } from "@/services/dataset/run-automated-sync";

/**
 * Retry a failed sync history item by clearing dedupe locks and re-running sync.
 */
export async function retryFailedUpload(historyEntryId: string): Promise<{
  cleared: boolean;
  outcome: AutomatedSyncOutcome;
}> {
  const entry = await getSyncHistoryEntry(historyEntryId);
  if (!entry) {
    throw new Error("Sync history entry not found.");
  }
  if (entry.status !== "failed") {
    throw new Error("Only failed sync history rows can be retried.");
  }

  if (entry.messageId && entry.originalName) {
    await forgetGmailAttachments([
      {
        messageId: entry.messageId,
        attachmentName: entry.originalName,
        size: entry.fileSize ?? 0,
        datasetName: entry.dataset,
      },
    ]);
  }

  await pushAppNotification({
    kind: "info",
    title: `Retrying ${entry.dataset} upload`,
    body: `Cleared duplicate locks for ${entry.fileName} and started a fresh sync.`,
    href: "/dataset/sync-history",
    meta: { historyEntryId, dataset: entry.dataset },
  });

  const outcome = await triggerDatasetSyncNow();
  return { cleared: true, outcome };
}

export async function retryAllFailedRecent(limit = 20) {
  const { listSyncHistory } = await import(
    "@/services/dataset/sync-history-store"
  );
  const failed = (await listSyncHistory(limit)).filter(
    (entry) => entry.status === "failed"
  );
  if (failed.length === 0) {
    throw new Error("No failed sync history rows to retry.");
  }

  const attachments = failed
    .filter((entry) => entry.messageId && entry.originalName)
    .map((entry) => ({
      messageId: entry.messageId as string,
      attachmentName: entry.originalName as string,
      size: entry.fileSize ?? 0,
      datasetName: entry.dataset,
    }));

  await forgetGmailAttachments(attachments);
  const outcome = await triggerDatasetSyncNow();
  return { retriedCount: failed.length, outcome };
}
