import { NextResponse } from "next/server";
import {
  buildExecutivePDashboardOpenings,
  getExecutivePDashboardFilterSchema,
} from "@/services/executive-processing/executive-p-dashboard-service";
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const refresh = searchParams.get("refresh") === "1";
  const schemaOnly = searchParams.get("schema") === "1";

  try {
    if (schemaOnly) {
      const schema = await getExecutivePDashboardFilterSchema({
        bypassCache: refresh,
      });
      return NextResponse.json({ ok: true, schema });
    }

    const filters = parseFilters(searchParams);
    const result = await buildExecutivePDashboardOpenings(filters, {
      bypassCache: refresh,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to build Executive P-Dashboard.";
    console.error("[api/excel/executive-p-dashboard]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
