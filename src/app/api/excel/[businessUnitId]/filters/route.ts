import { NextResponse } from "next/server";
import { getDynamicFilterSchema } from "@/services/excel/filter-schema";
import { getBusinessUnitById } from "@/constants/business-units";
import type { BusinessUnitId } from "@/types/business-unit";

export const runtime = "nodejs";

const VALID_UNITS: BusinessUnitId[] = ["lateral", "executive", "consulting"];

interface RouteContext {
  params: Promise<{ businessUnitId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const { businessUnitId: rawId } = await context.params;
  const businessUnitId = rawId as BusinessUnitId;

  if (!VALID_UNITS.includes(businessUnitId)) {
    return NextResponse.json(
      { error: `Unknown business unit: ${rawId}` },
      { status: 404 }
    );
  }

  if (!getBusinessUnitById(businessUnitId)) {
    return NextResponse.json(
      { error: `Business unit not registered: ${rawId}` },
      { status: 404 }
    );
  }

  const { searchParams } = new URL(request.url);
  const bypassCache = searchParams.get("refresh") === "1";

  try {
    // Lateral (Phase 8.3): PostgreSQL lateral_master via getDynamicFilterSchema.
    // Executive / Consulting: Excel/Drive (unchanged).
    const schema = await getDynamicFilterSchema(businessUnitId, {
      bypassCache,
    });
    return NextResponse.json(schema, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to discover filters";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
