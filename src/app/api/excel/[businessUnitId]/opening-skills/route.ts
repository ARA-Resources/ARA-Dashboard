import { NextResponse } from "next/server";
import { extractOpeningSkills } from "@/services/excel/extract-opening-skills";
import { getBusinessUnitById } from "@/constants/business-units";
import type { BusinessUnitId } from "@/types/business-unit";

export const runtime = "nodejs";

const VALID_UNITS: BusinessUnitId[] = ["lateral", "executive", "consulting"];

interface RouteContext {
  params: Promise<{ businessUnitId: string }>;
}

/**
 * GET /api/excel/:businessUnitId/opening-skills
 * Extracts Must Have / Good to Have skills from Master Sheet job descriptions.
 * Pass ?refresh=1 to bypass the Excel workbook cache.
 */
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
  const libraryOnly = searchParams.get("libraryOnly") === "1";
  const limitRaw = searchParams.get("limit");
  const limit =
    limitRaw && Number.isFinite(Number(limitRaw))
      ? Math.max(1, Math.min(Number(limitRaw), 50000))
      : null;

  try {
    const data = await extractOpeningSkills(businessUnitId, { bypassCache });
    const openings = libraryOnly
      ? []
      : limit
        ? data.openings.slice(0, limit)
        : data.openings;

    return NextResponse.json(
      {
        ...data,
        openings,
        skillLibraryCount: data.skillLibrary.length,
        returnedCount: openings.length,
      },
      {
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to extract opening skills";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
