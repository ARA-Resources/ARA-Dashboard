import { NextResponse } from "next/server";
import { exportLateralMasterSheetXlsx } from "@/services/excel/read-lateral-master-sheet";
import type { LateralMasterDateFilter } from "@/services/excel/lateral-master-sheet";

export const runtime = "nodejs";
export const maxDuration = 300;

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
  const columnFilters = parseJsonRecord<Record<string, string[]>>(
    searchParams.get("columnFilters"),
    {}
  );
  const textFilters = parseJsonRecord<Record<string, string>>(
    searchParams.get("textFilters"),
    {}
  );
  const dateFilters = parseJsonRecord<Record<string, LateralMasterDateFilter>>(
    searchParams.get("dateFilters"),
    {}
  );
  const search = (searchParams.get("search") || "").trim();

  try {
    const exported = await exportLateralMasterSheetXlsx(
      { columnFilters, textFilters, dateFilters, search: search || undefined },
      { bypassCache: refresh }
    );

    return new NextResponse(new Uint8Array(exported.buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${exported.fileName}"`,
        "Cache-Control": "no-store",
        "X-Export-Row-Count": String(exported.rowCount),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to export Lateral Master Sheet.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
