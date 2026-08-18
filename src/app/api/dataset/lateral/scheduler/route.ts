import { NextResponse } from "next/server";
import {
  ensureLateralSchedulerStarted,
  getLateralProcessingStatusView,
  getLateralSchedulerStatus,
  invokeLateralJob,
  pauseLateralScheduler,
  reloadLateralScheduler,
  resumeLateralScheduler,
  updateLateralScheduler,
} from "@/services/lateral-processing/lateral-scheduler";

export const runtime = "nodejs";
export const maxDuration = 600;

export async function GET() {
  await ensureLateralSchedulerStarted();
  const [status, processing] = await Promise.all([
    getLateralSchedulerStatus(),
    getLateralProcessingStatusView(),
  ]);
  return NextResponse.json(
    { ...status, processing },
    {
      headers: { "Cache-Control": "no-store" },
    }
  );
}

/**
 * POST actions: reload | pause | resume | run_now | update
 * Run Now and the daily cron both call invokeLateralJob → executeLateralDatasetJob.
 */
export async function POST(request: Request) {
  await ensureLateralSchedulerStarted();

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const action = typeof body.action === "string" ? body.action : "reload";

  try {
    if (action === "run_now") {
      const result = await invokeLateralJob("manual");
      const processing = await getLateralProcessingStatusView();
      return NextResponse.json({
        status: { ...result.status, processing },
        outcome: result.outcome,
      });
    }

    if (action === "pause") {
      const status = await pauseLateralScheduler();
      const processing = await getLateralProcessingStatusView();
      return NextResponse.json({ status: { ...status, processing } });
    }

    if (action === "resume") {
      const status = await resumeLateralScheduler();
      const processing = await getLateralProcessingStatusView();
      return NextResponse.json({ status: { ...status, processing } });
    }

    if (action === "update") {
      const status = await updateLateralScheduler({
        syncTime: typeof body.syncTime === "string" ? body.syncTime : undefined,
        timezone: typeof body.timezone === "string" ? body.timezone : undefined,
        enabled:
          typeof body.enabled === "boolean" ? body.enabled : undefined,
        paused: typeof body.paused === "boolean" ? body.paused : undefined,
      });
      const processing = await getLateralProcessingStatusView();
      return NextResponse.json({ status: { ...status, processing } });
    }

    const status = await reloadLateralScheduler();
    const processing = await getLateralProcessingStatusView();
    return NextResponse.json({ status: { ...status, processing } });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Lateral scheduler action failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
