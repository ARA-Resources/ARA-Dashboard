import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/dal";
import {
  startExecutivePostedRunDetached,
  getExecutivePostedRunStatus,
  readExecutivePostedSummary,
} from "@/services/executive-processing/executive-posted-run";

export const runtime = "nodejs";

/** Mirrors /api/dataset/lateral/posted/route.ts exactly — see that file's doc comment. */
export async function GET(request: Request) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;

  const [snapshot, lastPostedSummary] = await Promise.all([
    Promise.resolve(getExecutivePostedRunStatus()),
    readExecutivePostedSummary(),
  ]);

  return NextResponse.json(
    { ...snapshot, lastPostedSummary },
    { headers: { "Cache-Control": "no-store" } }
  );
}

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

  const started = await startExecutivePostedRunDetached({ force });
  if (!started.started) {
    return NextResponse.json({ ok: false, busy: true, message: started.message }, { status: 409 });
  }
  return NextResponse.json({ ok: true, started: true, runId: started.runId }, { status: 202 });
}
