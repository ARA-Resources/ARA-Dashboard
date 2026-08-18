import { NextResponse } from "next/server";
import { listSyncHistory } from "@/services/dataset/sync-history-store";

export const runtime = "nodejs";

/** List sync history rows for the Sync History page */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limitRaw = Number(searchParams.get("limit") ?? "100");
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(500, Math.floor(limitRaw))
      : 100;

  const entries = await listSyncHistory(limit);
  return NextResponse.json(
    { entries, count: entries.length },
    { headers: { "Cache-Control": "no-store" } }
  );
}
