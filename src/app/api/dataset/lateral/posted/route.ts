import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/dal";
import {
  startLateralPostedRunDetached,
  getLateralPostedRunStatus,
  readLateralPostedSummary,
} from "@/services/lateral-processing/lateral-posted-run";

export const runtime = "nodejs";

/**
 * GET: current/last Posted run state, same poll-and-read-back pattern as
 * /api/dataset/lateral/scheduler's GET (never holds a long connection).
 */
export async function GET(request: Request) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;

  const [snapshot, lastPostedSummary] = await Promise.all([
    Promise.resolve(getLateralPostedRunStatus()),
    readLateralPostedSummary(),
  ]);

  return NextResponse.json(
    { ...snapshot, lastPostedSummary },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * POST: try the lock; if busy, refuse at once (no background work started).
 * If acquired, start the work in the background (the lock is held until it
 * ends, released in the run's own `finally`) and return 202 immediately —
 * same reasoning as startLateralJobAsync: the reverse proxy may cut a long
 * HTTP request around ~60s, well short of a real Drive download+upload.
 * Closing the tab does not stop the run; poll GET for its outcome.
 */
export async function POST(request: Request) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const force = body.force === true;

  const started = await startLateralPostedRunDetached({ force });
  if (!started.started) {
    return NextResponse.json({ ok: false, busy: true, message: started.message }, { status: 409 });
  }
  return NextResponse.json({ ok: true, started: true, runId: started.runId }, { status: 202 });
}
