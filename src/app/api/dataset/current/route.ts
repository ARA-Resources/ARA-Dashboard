import { NextResponse } from "next/server";
import { listCurrentDatasetFiles } from "@/services/dataset/resolve-current";
import { ensureAllCurrentDatasets } from "@/services/dataset/seed-current";

export const runtime = "nodejs";

/**
 * Lists latest Dataset Manager current workbooks used by Company dashboards.
 * Optional `?seed=1` bootstraps missing currents from legacy seed candidates.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    if (searchParams.get("seed") === "1") {
      await ensureAllCurrentDatasets();
    }

    const datasets = await listCurrentDatasetFiles();
    return NextResponse.json(
      {
        datasets: datasets.map((item) => ({
          datasetName: item.datasetName,
          businessUnitId: item.businessUnitId,
          fileName: item.fileName,
          filePath: item.filePath,
          mtimeMs: item.mtimeMs,
          size: item.size,
          source: item.source,
          updatedAt: new Date(item.mtimeMs).toISOString(),
        })),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list current datasets";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
