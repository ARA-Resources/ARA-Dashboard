import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/dal";
import { listExecutiveSyncHistory } from "@/services/executive-processing/executive-sync-history-store";

export const runtime = "nodejs";

/**
 * Executive-only sync history for Dataset UI.
 * Never returns OAuth tokens or credentials.
 * Unlike the Lateral sync-history route, this one gates on authorizeRequest
 * (a small consistency improvement — not a change to Lateral's route).
 */
export async function GET(request: Request) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;

  const { searchParams } = new URL(request.url);
  const limitRaw = Number(searchParams.get("limit") ?? "100");
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(500, Math.floor(limitRaw))
      : 100;

  const entries = await listExecutiveSyncHistory(limit);
  return NextResponse.json(
    {
      datasetName: "Executive",
      entries,
      count: entries.length,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
