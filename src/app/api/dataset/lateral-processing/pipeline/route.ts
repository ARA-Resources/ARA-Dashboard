import { NextResponse } from "next/server";
import { runLateralDatasetPipeline } from "@/services/lateral-processing/pipeline";

export const runtime = "nodejs";

/** Full Lateral pipeline (config → Drive → New Sheet → reconcile → VBA → Dataset Manager). */
export const maxDuration = 300;

export async function POST() {
  try {
    const result = await runLateralDatasetPipeline();
    if (!result.ok) {
      return NextResponse.json(result, { status: 500 });
    }
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unexpected error in Lateral Dataset Processing Pipeline.";
    const status = /OAuth|not connected|permission|forbidden/i.test(message)
      ? 401
      : 500;
    return NextResponse.json(
      {
        ok: false,
        failedStep: 0,
        failedStepName: "Pipeline",
        reason: message,
        timestamp: new Date().toISOString(),
        suggestedAction:
          "Check Google Drive / Excel connectivity, then re-run the pipeline.",
        errorLogPath: "",
        steps: [],
        previousMasterPreserved: true,
      },
      { status }
    );
  }
}
