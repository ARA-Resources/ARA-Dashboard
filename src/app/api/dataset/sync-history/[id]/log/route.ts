import { NextResponse } from "next/server";
import {
  getSyncHistoryEntry,
  readSyncLogFile,
} from "@/services/dataset/sync-history-store";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Download sync logs for a history row.
 * - Prefer the day's JSONL log tied to the entry
 * - Fall back to a JSON dump of the history entry itself
 */
export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const entry = await getSyncHistoryEntry(id);

  if (!entry) {
    return NextResponse.json(
      { error: "Sync history entry not found." },
      { status: 404 }
    );
  }

  const logText = await readSyncLogFile(entry.logDay);
  if (logText && logText.trim().length > 0) {
    return new NextResponse(logText, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="dataset-sync-${entry.logDay}-${entry.dataset}.jsonl"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const fallback = JSON.stringify(
    {
      entry,
      note: "No JSONL sync log was found for this day. Returning the history entry.",
    },
    null,
    2
  );

  return new NextResponse(fallback, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="sync-history-${entry.id}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
