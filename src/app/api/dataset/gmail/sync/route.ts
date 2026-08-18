import { NextResponse } from "next/server";
import { triggerDatasetSyncNow } from "@/services/dataset/scheduler";
import { runScheduledDatasetSync } from "@/services/dataset/sync-download";
import { markSuccessfulSync } from "@/services/dataset/sync-watermark-store";

export const runtime = "nodejs";

/**
 * Runs the full automation path (same as the daily scheduler):
 * Gmail → download → validate → Drive → cache refresh → notify.
 *
 * Default search window: after last successful sync (incremental).
 * Optional body:
 * { date?, dateMode?, scanMode?, selectedRowIds?, datasetNames?, single? }
 */
export async function POST(request: Request) {
  let body: {
    date?: string;
    dateMode?: string;
    scanMode?: "incremental" | "date";
    selectedRowIds?: string[];
    datasetNames?: string[];
    single?: boolean;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  try {
    if (body.selectedRowIds?.length || body.single || body.scanMode === "date") {
      const scanMode =
        body.scanMode ?? (body.date ? "date" : "incremental");
      const result = await runScheduledDatasetSync({
        date: body.date,
        dateMode: body.dateMode,
        scanMode,
        selectedRowIds: body.selectedRowIds,
        datasetNames: body.datasetNames,
      });
      // Only advance the incremental cursor for incremental windows that didn't fully fail.
      if (
        scanMode === "incremental" &&
        !(result.failedCount > 0 && result.downloadedCount === 0)
      ) {
        await markSuccessfulSync({ trigger: "manual" });
      }
      return NextResponse.json({
        ...result,
        automation: {
          trigger: "manual",
          status: result.failedCount > 0 ? "partial" : "ok",
          message: body.selectedRowIds?.length
            ? `Synced ${body.selectedRowIds.length} selected file(s).`
            : "Manual sync complete.",
        },
      });
    }

    const outcome = await triggerDatasetSyncNow({
      datasetNames: body.datasetNames as
        | import("@/types/dataset-sync").DatasetSyncName[]
        | undefined,
    });
    return NextResponse.json({
      ...outcome.result,
      automation: {
        trigger: outcome.trigger,
        status: outcome.status,
        message: outcome.message,
        notificationIds: outcome.notificationIds,
        historyEntryIds: outcome.historyEntryIds,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Dataset sync failed.";
    const status = /already running/i.test(message)
      ? 409
      : /setup|not connected|OAuth/i.test(message)
        ? 401
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET() {
  return POST(
    new Request("http://local/api/dataset/gmail/sync", { method: "POST" })
  );
}
