import { NextResponse } from "next/server";
import { listLateralSyncHistory } from "@/services/lateral-processing/lateral-sync-history-store";

export const runtime = "nodejs";

/**
 * Lateral-only sync history for Dataset UI.
 * Never returns OAuth tokens or credentials.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limitRaw = Number(searchParams.get("limit") ?? "100");
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(500, Math.floor(limitRaw))
      : 100;

  const entries = await listLateralSyncHistory(limit);
  return NextResponse.json(
    {
      datasetName: "Lateral",
      entries,
      count: entries.length,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
