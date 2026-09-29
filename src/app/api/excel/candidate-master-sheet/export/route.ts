import { NextResponse } from "next/server";
import { buildMasterSheetXlsxBuffer } from "@/services/excel/build-master-sheet-xlsx";
import { exportCandidateMasterSheetRows } from "@/services/persistence/candidate-master-sheet-postgres";
import type {
  CandidateHighlightFilterValue,
  CandidateMasterDateFilter,
} from "@/services/excel/candidate-master-sheet";

export const runtime = "nodejs";

function parseJsonRecord<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function buildFileName(query: {
  columnFilters: Record<string, string[]>;
  textFilters: Record<string, string>;
  dateFilters: Record<string, CandidateMasterDateFilter>;
  highlightFilters: CandidateHighlightFilterValue[];
  syncFilter: number | null;
}): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const hasColumn = Object.values(query.columnFilters).some((v) => v.length > 0);
  const hasText = Object.values(query.textFilters).some((v) => v.trim().length > 0);
  const hasDate = Object.values(query.dateFilters).some((r) => Boolean(r.from || r.to));
  const hasSync = query.syncFilter != null;
  const hasOtherFilters = hasColumn || hasText || hasDate || hasSync;

  if (!hasOtherFilters && query.highlightFilters.length === 1) {
    return `Candidate-Master-Sheet-${stamp}-${query.highlightFilters[0]}.xlsx`;
  }
  if (hasOtherFilters || query.highlightFilters.length > 0) {
    return `Candidate-Master-Sheet-${stamp}-filtered.xlsx`;
  }
  return `Candidate-Master-Sheet-${stamp}.xlsx`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const columnFilters = parseJsonRecord<Record<string, string[]>>(
    searchParams.get("columnFilters"),
    {}
  );
  const textFilters = parseJsonRecord<Record<string, string>>(
    searchParams.get("textFilters"),
    {}
  );
  const dateFilters = parseJsonRecord<Record<string, CandidateMasterDateFilter>>(
    searchParams.get("dateFilters"),
    {}
  );
  const highlightFilters = parseJsonRecord<CandidateHighlightFilterValue[]>(
    searchParams.get("highlightFilters"),
    []
  );
  const syncFilterRaw = searchParams.get("syncFilter");
  const syncFilter =
    syncFilterRaw && Number.isFinite(Number(syncFilterRaw)) ? Number(syncFilterRaw) : null;
  const query = { columnFilters, textFilters, dateFilters, highlightFilters, syncFilter };

  try {
    const exported = await exportCandidateMasterSheetRows(query);
    const buffer = await buildMasterSheetXlsxBuffer({
      sheetName: exported.sheetName,
      headers: exported.headers,
      rows: exported.rows,
    });

    const fileName = buildFileName(query);

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
        "X-Export-Row-Count": String(exported.rows.length),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to export Candidate Master Sheet.";
    console.error("[api/excel/candidate-master-sheet/export]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
