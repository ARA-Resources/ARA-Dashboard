import { NextResponse } from "next/server";
import { getDatasetConfigurationOverview } from "@/services/dataset/configuration-overview";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import { scanGmailExcelAttachments } from "@/services/gmail/scan";
import {
  resolveDriveFolderIdForDataset,
} from "@/services/drive/folder";
import { readDatasetSetup } from "@/services/dataset/secure-store";
import {
  triggerDatasetSyncNow,
} from "@/services/dataset/scheduler";
import { DATASET_SYNC_NAMES, type DatasetSyncName } from "@/types/dataset-sync";
import {
  assertExecutableDatasetType,
  isExecutableDatasetType,
} from "@/types/dataset-execution";

export const runtime = "nodejs";

export async function GET() {
  try {
    const overview = await getDatasetConfigurationOverview();
    return NextResponse.json(overview, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load configuration overview.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Quick actions from the Dataset Configuration Dashboard.
 * action: run_now | pause | resume | test_gmail | test_upload
 */
export async function POST(request: Request) {
  let body: {
    action?: string;
    datasetName?: string;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const action = body.action ?? "";
  const datasetName = body.datasetName as DatasetSyncName | undefined;

  if (
    !datasetName ||
    !DATASET_SYNC_NAMES.includes(datasetName)
  ) {
    return NextResponse.json(
      { error: "Valid datasetName is required (Lateral|Executive|Consulting)." },
      { status: 400 }
    );
  }

  try {
    if (action === "run_now") {
      assertExecutableDatasetType(datasetName);
      const outcome = await triggerDatasetSyncNow({
        datasetNames: [datasetName],
      });
      return NextResponse.json({
        ok: true,
        message: outcome.message,
        outcome,
        overview: await getDatasetConfigurationOverview(),
      });
    }

    if (action === "pause" || action === "resume") {
      if (datasetName === "Lateral") {
        const {
          pauseLateralScheduler,
          resumeLateralScheduler,
        } = await import("@/services/lateral-processing/lateral-scheduler");
        if (action === "pause") await pauseLateralScheduler();
        else await resumeLateralScheduler();
        return NextResponse.json({
          ok: true,
          message:
            action === "pause"
              ? "Paused Lateral dedicated schedule."
              : "Resumed Lateral dedicated schedule.",
          overview: await getDatasetConfigurationOverview(),
        });
      }
      return NextResponse.json(
        {
          error: `${datasetName} automation is not enabled yet. Only Lateral runs currently.`,
        },
        { status: 400 }
      );
    }

    if (action === "test_gmail") {
      if (!isExecutableDatasetType(datasetName)) {
        return NextResponse.json({
          ok: true,
          message: `${datasetName} keyword search is retained for future setup, but only Lateral Gmail processing runs currently.`,
          previewOnly: true,
        });
      }
      const scan = await scanGmailExcelAttachments({
        datasetNames: [datasetName],
      });
      const newest = scan.rows.filter((row) => row.status === "Newest").length;
      return NextResponse.json({
        ok: true,
        message: `Gmail search for ${datasetName}: ${scan.messageCount} message(s), ${scan.rows.length} attachment match(es), ${newest} newest.`,
        scan: {
          query: scan.queries.find((item) => item.datasetName === datasetName)
            ?.query,
          messageCount: scan.messageCount,
          matchCount: scan.rows.length,
          newestCount: newest,
          sample: scan.rows.slice(0, 5).map((row) => ({
            subject: row.subject,
            attachmentName: row.attachmentName,
            matchedKeyword: row.matchedKeyword,
            matchedIn: row.matchedIn,
            status: row.status,
          })),
        },
      });
    }

    if (action === "test_upload") {
      const setup = await readDatasetSetup();
      if (!setup) {
        return NextResponse.json(
          { error: "Complete Dataset setup first." },
          { status: 400 }
        );
      }
      const folderId = resolveDriveFolderIdForDataset(setup, datasetName);
      const { drive } = await getAuthorizedGmailClient();
      const folder = await drive.files.get({
        fileId: folderId,
        fields: "id, name, webViewLink, mimeType",
        supportsAllDrives: true,
      });
      if (folder.data.mimeType !== "application/vnd.google-apps.folder") {
        return NextResponse.json(
          { error: "Mapped Drive ID is not a folder." },
          { status: 400 }
        );
      }
      return NextResponse.json({
        ok: true,
        message: `Drive folder reachable for ${datasetName}: ${folder.data.name} (${folder.data.id}). Upload path is ready.`,
        folder: {
          id: folder.data.id,
          name: folder.data.name,
          webViewLink: folder.data.webViewLink,
        },
      });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Action failed.";
    const status = /already running/i.test(message)
      ? 409
      : /not connected|OAuth|setup/i.test(message)
        ? 401
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
