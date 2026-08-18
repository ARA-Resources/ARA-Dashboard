import { NextResponse } from "next/server";
import { readTopOpenings } from "@/services/excel/reader";
import { getBusinessUnitById } from "@/constants/business-units";
import type { BusinessUnitId } from "@/types/business-unit";
import type { OpeningsFilters, SortDirection } from "@/types/filters";

export const runtime = "nodejs";

const VALID_UNITS: BusinessUnitId[] = ["lateral", "executive", "consulting"];

interface RouteContext {
  params: Promise<{ businessUnitId: string }>;
}

function parseFilters(searchParams: URLSearchParams): Partial<OpeningsFilters> {
  const filters: Partial<OpeningsFilters> = {};

  const rawColumnFilters = searchParams.get("columnFilters");
  if (rawColumnFilters) {
    try {
      const parsed = JSON.parse(rawColumnFilters) as Record<string, string[]>;
      if (parsed && typeof parsed === "object") {
        filters.columnFilters = parsed;
      }
    } catch {
      filters.columnFilters = {};
    }
  }

  if (searchParams.has("sortBy")) {
    const sortBy = searchParams.get("sortBy");
    filters.sortBy = sortBy && sortBy.length > 0 ? sortBy : null;
  }

  if (searchParams.has("sortDir")) {
    const sortDir = searchParams.get("sortDir");
    if (sortDir === "asc" || sortDir === "desc") {
      filters.sortDirection = sortDir as SortDirection;
    }
  }

  if (searchParams.has("top")) {
    const topRaw = searchParams.get("top");
    if (topRaw === "" || topRaw === "all" || topRaw === "null") {
      filters.topN = null;
    } else {
      const top = Number(topRaw);
      filters.topN =
        Number.isFinite(top) && top > 0 ? Math.min(top, 500) : null;
    }
  }

  return filters;
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
  const filters = parseFilters(searchParams);

  try {
    const data = await readTopOpenings(businessUnitId, filters, {
      bypassCache,
    });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to read Excel source";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
