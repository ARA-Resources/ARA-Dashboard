import { NextResponse } from "next/server";
import {
  listDatasetVersions,
  rollbackDatasetVersion,
} from "@/services/dataset/versions";
import {
  retryAllFailedRecent,
  retryFailedUpload,
} from "@/services/dataset/retry-failed";
import { readDatasetSetup } from "@/services/dataset/secure-store";
import { readSyncWatermark } from "@/services/dataset/sync-watermark-store";
import { buildAllDatasetQueries } from "@/services/gmail/query";
import { getGmailDedupeSummary } from "@/services/gmail/scan";
import { isFailureEmailConfigured } from "@/services/dataset/failure-email";

export const runtime = "nodejs";

/** Enterprise ops read model: versions, filters, dedupe, alerts */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const dataset = searchParams.get("dataset") ?? undefined;
  const setup = await readDatasetSetup();

  const [versions, dedupe, watermark] = await Promise.all([
    listDatasetVersions(dataset ?? undefined),
    getGmailDedupeSummary(),
    readSyncWatermark(),
  ]);

  const datasetQueries = setup
    ? buildAllDatasetQueries(setup, {
        afterMs: watermark.lastSuccessfulSyncAtMs ?? undefined,
      })
    : [];

  return NextResponse.json(
    {
      versions,
      duplicateDetection: dedupe,
      checksumValidation: { enabled: true, algorithm: "SHA-256" },
      emailFiltering: setup
        ? {
            independentSearches: true,
            lastSuccessfulSyncAt: watermark.lastSuccessfulSyncAt,
            datasets: datasetQueries.map(({ datasetName, query, config }) => ({
              datasetName,
              enabled: config.enabled,
              searchKeywords: config.keywords.map((keyword) => keyword.value),
              keywords: config.keywords,
              fileTypes: config.fileTypes,
              query,
            })),
            query: datasetQueries
              .map((item) => `[${item.datasetName}] ${item.query}`)
              .join(" | "),
          }
        : null,
      failureEmailAlerts: { configured: isFailureEmailConfigured() },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * POST actions:
 * - retry { historyEntryId }
 * - retry_all_failed
 * - rollback { datasetName, fileName }
 */
export async function POST(request: Request) {
  let body: {
    action?: string;
    historyEntryId?: string;
    datasetName?: string;
    fileName?: string;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  try {
    if (body.action === "retry") {
      if (!body.historyEntryId) {
        return NextResponse.json(
          { error: "historyEntryId is required." },
          { status: 400 }
        );
      }
      const result = await retryFailedUpload(body.historyEntryId);
      return NextResponse.json(result);
    }

    if (body.action === "retry_all_failed") {
      const result = await retryAllFailedRecent();
      return NextResponse.json(result);
    }

    if (body.action === "rollback") {
      if (!body.datasetName || !body.fileName) {
        return NextResponse.json(
          { error: "datasetName and fileName are required." },
          { status: 400 }
        );
      }
      const result = await rollbackDatasetVersion({
        datasetName: body.datasetName,
        fileName: body.fileName,
      });
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Enterprise ops action failed.";
    const status = /already running/i.test(message)
      ? 409
      : /not found/i.test(message)
        ? 404
        : /setup|not connected|OAuth/i.test(message)
          ? 401
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
