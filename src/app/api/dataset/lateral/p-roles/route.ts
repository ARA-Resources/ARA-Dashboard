import { NextResponse } from "next/server";
import { buildLateralPRolesOpenings } from "@/services/lateral-processing/lateral-p-roles-service";
import type { OpeningsFilters, SortDirection } from "@/types/filters";

export const runtime = "nodejs";
export const maxDuration = 120;

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
  } else {
    filters.columnFilters = {};
  }

  if (searchParams.has("sortBy")) {
    const sortBy = searchParams.get("sortBy");
    filters.sortBy = sortBy && sortBy.length > 0 ? sortBy : null;
  } else {
    filters.sortBy = null;
  }

  if (searchParams.has("sortDir")) {
    const sortDir = searchParams.get("sortDir");
    if (sortDir === "asc" || sortDir === "desc") {
      filters.sortDirection = sortDir as SortDirection;
    }
  }
  if (!filters.sortDirection) {
    filters.sortDirection = "desc";
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
  } else {
    filters.topN = null;
  }

  return filters;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filters = parseFilters(searchParams);
  try {
    const result = await buildLateralPRolesOpenings(
      filters as OpeningsFilters,
      { forceVercelSafeNative: true }
    );
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to build lateral P-Roles dataset.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
