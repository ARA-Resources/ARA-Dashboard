import { NextResponse } from "next/server";
import { listSenderStatistics } from "@/services/dataset/sender-stats-store";
import { readDatasetSetup } from "@/services/dataset/secure-store";

export const runtime = "nodejs";

export async function GET() {
  const setup = await readDatasetSetup();
  const stats = await listSenderStatistics(setup);
  return NextResponse.json(
    {
      configured: Boolean(setup),
      stats,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
