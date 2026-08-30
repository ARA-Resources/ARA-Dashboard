import { NextResponse } from "next/server";
import {
  DEFAULT_EXECUTIVE_MASTER_PAGE_SIZE,
  EXECUTIVE_MASTER_PAGE_SIZE_OPTIONS,
  type ExecutiveMasterDateFilter,
  type ExecutiveMasterPageSize,
} from "@/services/excel/executive-master-sheet";
import {
  getExecutiveMasterFilterSchema,
  queryExecutiveMasterSheet,
} from "@/services/excel/read-executive-master-sheet";

export const runtime = "nodejs";
export const maxDuration = 120;

function parsePageSize(raw: string | null): ExecutiveMasterPageSize {
  const n = Number(raw);
  if (
    EXECUTIVE_MASTER_PAGE_SIZE_OPTIONS.includes(n as ExecutiveMasterPageSize)
  ) {
    return n as ExecutiveMasterPageSize;
  }
  return DEFAULT_EXECUTIVE_MASTER_PAGE_SIZE;
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
      const schema = await getExecutiveMasterFilterSchema({
        bypassCache: refresh,
      });
      return NextResponse.json({ ok: true, schema });
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
      Record<string, ExecutiveMasterDateFilter>
    >(searchParams.get("dateFilters"), {});

    const result = await queryExecutiveMasterSheet(
      {
        page,
        pageSize,
        columnFilters,
        textFilters,
        dateFilters,
      },
      { bypassCache: refresh }
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Executive Master Sheet could not be loaded.";
    console.error("[api/excel/executive-master-sheet]", message);
    const status = /not found|could not be loaded|Missing|missing/i.test(
      message
    )
      ? 404
      : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
