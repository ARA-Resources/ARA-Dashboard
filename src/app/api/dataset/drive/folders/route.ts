import { NextResponse } from "next/server";
import { getDatasetDriveFolderStatistics } from "@/services/drive/folder-stats";
import { readDatasetSetup } from "@/services/dataset/secure-store";

export const runtime = "nodejs";

/**
 * Folder mapping stats.
 * Default: local metadata (fast).
 * `?live=1`: refresh totals from Google Drive (cached briefly).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const live = searchParams.get("live") === "1";
  const setup = await readDatasetSetup();
  const folders = await getDatasetDriveFolderStatistics(setup, { live });
  return NextResponse.json(
    {
      configured: Boolean(setup),
      live,
      folders,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
