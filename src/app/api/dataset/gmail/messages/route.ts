import { NextResponse } from "next/server";
import {
  scanGmailExcelAttachments,
  setManualDatasetSelection,
} from "@/services/gmail/scan";
import { DATASET_SYNC_NAMES, type DatasetSyncName } from "@/types/dataset-sync";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get("date");
    const dateMode = searchParams.get("dateMode");
    const scanMode = searchParams.get("scanMode");
    const result = await scanGmailExcelAttachments({
      date: date ?? undefined,
      dateMode: dateMode ?? undefined,
      scanMode: scanMode ?? undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to scan Gmail.";
    const status =
      /not connected|OAuth|Complete Dataset setup/i.test(message) ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * Manual override: choose which matched file is Newest for a dataset.
 * Body: { action: "select", datasetName, rowId, date }
 * `date` may be a calendar day or incremental key (`after:<ms>`).
 */
export async function POST(request: Request) {
  let body: {
    action?: string;
    datasetName?: string;
    rowId?: string;
    date?: string;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  try {
    if (body.action === "select") {
      const datasetName = body.datasetName as DatasetSyncName | undefined;
      if (
        !datasetName ||
        !DATASET_SYNC_NAMES.includes(datasetName) ||
        !body.rowId ||
        !body.date
      ) {
        return NextResponse.json(
          { error: "datasetName, rowId, and date are required." },
          { status: 400 }
        );
      }
      await setManualDatasetSelection({
        datasetName,
        rowId: body.rowId,
        date: body.date,
      });
      const result = await scanGmailExcelAttachments(
        body.date.startsWith("after:")
          ? { scanMode: "incremental" }
          : { date: body.date, scanMode: "date" }
      );
      return NextResponse.json({
        ok: true,
        message: `Selected ${body.rowId} for ${datasetName}.`,
        ...result,
      });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update selection.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
