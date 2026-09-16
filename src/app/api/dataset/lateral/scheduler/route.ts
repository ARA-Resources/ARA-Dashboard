import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/dal";
import {
  ensureLateralSchedulerStarted,
  getLateralProcessingStatusView,
  getLateralSchedulerStatus,
  pauseLateralScheduler,
  reloadLateralScheduler,
  resumeLateralScheduler,
  startLateralJobAsync,
  updateLateralScheduler,
} from "@/services/lateral-processing/lateral-scheduler";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;
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
 * The daily cron calls invokeLateralJob → executeLateralDatasetJob and awaits
 * it fully (in-process node-cron callback, no HTTP round-trip to time out).
 * Run Now instead calls startLateralJobAsync, which starts the same job and
 * returns immediately — the job's progress and eventual outcome are read
 * back via GET polling (the same live status this route's GET returns),
 * not via this POST's response. This avoids the reverse proxy's
 * proxy_read_timeout killing the connection long before the ~5-6 minute job
 * finishes, which previously caused the UI to report failure on a run that
 * was actually still succeeding in the background.
 */
export async function POST(request: Request) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;
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
      const result = await startLateralJobAsync("manual");
      if (!result.ok) {
        return NextResponse.json({ error: result.message }, { status: 400 });
      }
      return NextResponse.json({ ok: true, started: true, startedAt: new Date().toISOString() });
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
