import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/dal";
import type { ScheduleFrequency } from "@/types/dataset-schedule";
import {
  ensureExecutiveSchedulerStarted,
  getExecutiveProcessingStatusView,
  getExecutiveSchedulerStatus,
  pauseExecutiveScheduler,
  reloadExecutiveScheduler,
  resumeExecutiveScheduler,
  runExecutiveJobAndPersist,
  updateExecutiveScheduler,
} from "@/services/executive-processing/executive-scheduler";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;
  await ensureExecutiveSchedulerStarted();
  const [status, processing] = await Promise.all([
    getExecutiveSchedulerStatus(),
    getExecutiveProcessingStatusView(),
  ]);
  return NextResponse.json(
    { ...status, processing },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * POST actions: reload | pause | resume | run_now | update
 * Run Now and the (currently-off-by-default) cron tick both call
 * runExecutiveJobAndPersist -> invokeExecutiveJob -> executive_master reconcile.
 */
export async function POST(request: Request) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;
  await ensureExecutiveSchedulerStarted();

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const action = typeof body.action === "string" ? body.action : "reload";

  try {
    if (action === "run_now") {
      const outcome = await runExecutiveJobAndPersist("manual");
      const [status, processing] = await Promise.all([
        getExecutiveSchedulerStatus(),
        getExecutiveProcessingStatusView(),
      ]);
      return NextResponse.json({ status: { ...status, processing }, outcome });
    }

    if (action === "pause") {
      const status = await pauseExecutiveScheduler();
      const processing = await getExecutiveProcessingStatusView();
      return NextResponse.json({ status: { ...status, processing } });
    }

    if (action === "resume") {
      const status = await resumeExecutiveScheduler();
      const processing = await getExecutiveProcessingStatusView();
      return NextResponse.json({ status: { ...status, processing } });
    }

    if (action === "update") {
      const allowedFrequencies: readonly string[] = [
        "hourly",
        "daily",
        "weekdays",
        "weekly",
        "custom",
      ];
      const status = await updateExecutiveScheduler({
        frequency:
          typeof body.frequency === "string" &&
          allowedFrequencies.includes(body.frequency)
            ? (body.frequency as ScheduleFrequency)
            : undefined,
        syncTime: typeof body.syncTime === "string" ? body.syncTime : undefined,
        dayOfWeek:
          typeof body.dayOfWeek === "number" ? body.dayOfWeek : undefined,
        customDays: Array.isArray(body.customDays)
          ? (body.customDays as number[])
          : undefined,
        customTimes: Array.isArray(body.customTimes)
          ? (body.customTimes as string[])
          : undefined,
        timezone: typeof body.timezone === "string" ? body.timezone : undefined,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        paused: typeof body.paused === "boolean" ? body.paused : undefined,
      });
      const processing = await getExecutiveProcessingStatusView();
      return NextResponse.json({ status: { ...status, processing } });
    }

    const status = await reloadExecutiveScheduler();
    const processing = await getExecutiveProcessingStatusView();
    return NextResponse.json({ status: { ...status, processing } });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Executive scheduler action failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
