import { NextResponse } from "next/server";
import {
  createOrUpdateSchedule,
  ensureDatasetSchedulerStarted,
  getDatasetSchedulerStatusAsync,
  pauseDatasetScheduler,
  reloadDatasetScheduler,
  removeSchedule,
  resumeDatasetScheduler,
  setScheduleEnabled,
  setSchedulePaused,
  triggerDatasetSyncNow,
} from "@/services/dataset/scheduler";
import { listAutomationSchedules } from "@/services/dataset/schedules-store";

export const runtime = "nodejs";

/** List schedules + overall scheduler status */
export async function GET() {
  await ensureDatasetSchedulerStarted();
  const status = await getDatasetSchedulerStatusAsync();
  return NextResponse.json(status, {
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * POST actions:
 * - reload | pause | resume | run_now (global)
 * - create | update | delete | pause_one | resume_one | enable | disable | run_one
 */
export async function POST(request: Request) {
  await ensureDatasetSchedulerStarted();

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const action = typeof body.action === "string" ? body.action : "reload";

  try {
    if (action === "run_now") {
      const outcome = await triggerDatasetSyncNow({
        scheduleId:
          typeof body.scheduleId === "string" ? body.scheduleId : undefined,
        datasetNames: Array.isArray(body.datasetNames)
          ? (body.datasetNames as never)
          : undefined,
      });
      return NextResponse.json({
        scheduler: await getDatasetSchedulerStatusAsync(),
        outcome,
      });
    }

    if (action === "pause") {
      const scheduler = await pauseDatasetScheduler();
      return NextResponse.json({ scheduler });
    }

    if (action === "resume") {
      const scheduler = await resumeDatasetScheduler();
      return NextResponse.json({ scheduler });
    }

    if (action === "create" || action === "update") {
      const schedule = await createOrUpdateSchedule(body.schedule ?? body);
      return NextResponse.json({
        schedule,
        scheduler: await getDatasetSchedulerStatusAsync(),
        schedules: await listAutomationSchedules(),
      });
    }

    if (action === "delete") {
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) {
        return NextResponse.json({ error: "Schedule id required." }, { status: 400 });
      }
      await removeSchedule(id);
      return NextResponse.json({
        scheduler: await getDatasetSchedulerStatusAsync(),
      });
    }

    if (action === "pause_one" || action === "resume_one") {
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) {
        return NextResponse.json({ error: "Schedule id required." }, { status: 400 });
      }
      const schedule = await setSchedulePaused(id, action === "pause_one");
      return NextResponse.json({
        schedule,
        scheduler: await getDatasetSchedulerStatusAsync(),
      });
    }

    if (action === "enable" || action === "disable") {
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) {
        return NextResponse.json({ error: "Schedule id required." }, { status: 400 });
      }
      const schedule = await setScheduleEnabled(id, action === "enable");
      return NextResponse.json({
        schedule,
        scheduler: await getDatasetSchedulerStatusAsync(),
      });
    }

    if (action === "run_one") {
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) {
        return NextResponse.json({ error: "Schedule id required." }, { status: 400 });
      }
      const outcome = await triggerDatasetSyncNow({ scheduleId: id });
      return NextResponse.json({
        outcome,
        scheduler: await getDatasetSchedulerStatusAsync(),
      });
    }

    const scheduler = await reloadDatasetScheduler();
    return NextResponse.json({ scheduler });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Scheduler action failed.";
    const status = /already running/i.test(message)
      ? 409
      : /not found/i.test(message)
        ? 404
        : /setup|not connected|OAuth|Enter |Select |Invalid/i.test(message)
          ? 400
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
