import { getHomeDashboardWidgets } from "@/services/home/build-home-widgets";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const bypassCache = searchParams.get("refresh") === "1";
    const payload = await getHomeDashboardWidgets({ bypassCache });

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "private, max-age=60, stale-while-revalidate=120",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to build home widgets";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
