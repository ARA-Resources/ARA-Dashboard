import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Anonymous liveness probe for Windows service / load balancer. No secrets. */
export async function GET() {
  return NextResponse.json(
    { ok: true, live: true },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-ARA-Healthy": "1",
      },
    }
  );
}
