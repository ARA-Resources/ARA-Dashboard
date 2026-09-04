import { NextResponse } from "next/server";
import {
  DEFAULT_LATERAL_MASTER_PAGE_SIZE,
  LATERAL_MASTER_PAGE_SIZE_OPTIONS,
  type LateralMasterDateFilter,
  type LateralMasterPageSize,
} from "@/services/excel/lateral-master-sheet";
import {
  getLateralMasterFilterSchema,
  queryLateralMasterSheet,
} from "@/services/excel/read-lateral-master-sheet";

export const runtime = "nodejs";
export const maxDuration = 120;

function parsePageSize(raw: string | null): LateralMasterPageSize {
  const n = Number(raw);
  if (
    LATERAL_MASTER_PAGE_SIZE_OPTIONS.includes(n as LateralMasterPageSize)
  ) {
    return n as LateralMasterPageSize;
  }
  return DEFAULT_LATERAL_MASTER_PAGE_SIZE;
}

function parseJsonRecord<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const refresh = searchParams.get("refresh") === "1";
  const schemaOnly = searchParams.get("schema") === "1";

  try {
    if (schemaOnly) {
      const schema = await getLateralMasterFilterSchema({
        bypassCache: refresh,
      });
      return NextResponse.json(
        { ok: true, schema },
        {
          headers: {
            "Cache-Control": "private, max-age=60, stale-while-revalidate=120",
          },
        }
      );
    }

    const page = Math.max(1, Number(searchParams.get("page") || "1") || 1);
    const pageSize = parsePageSize(searchParams.get("pageSize"));
    const columnFilters = parseJsonRecord<Record<string, string[]>>(
      searchParams.get("columnFilters"),
      {}
    );
    const textFilters = parseJsonRecord<Record<string, string>>(
      searchParams.get("textFilters"),
      {}
    );
    const dateFilters = parseJsonRecord<
      Record<string, LateralMasterDateFilter>
    >(searchParams.get("dateFilters"), {});
    const search = (searchParams.get("search") || "").trim();

    const result = await queryLateralMasterSheet(
      {
        page,
        pageSize,
        columnFilters,
        textFilters,
        dateFilters,
        search: search || undefined,
      },
      { bypassCache: refresh }
    );

    return NextResponse.json(
      { ok: true, ...result },
      {
        headers: {
          "Cache-Control": refresh
            ? "no-store"
            : "private, max-age=15, stale-while-revalidate=60",
        },
      }
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load Lateral Master Sheet.";
    const status = /not found|No synchronized dataset/i.test(message)
      ? 404
      : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
