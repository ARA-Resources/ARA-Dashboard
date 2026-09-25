import { NextResponse } from "next/server";
import {
  DEFAULT_CANDIDATE_MASTER_PAGE_SIZE,
  CANDIDATE_MASTER_PAGE_SIZE_OPTIONS,
  type CandidateHighlightFilterValue,
  type CandidateMasterDateFilter,
  type CandidateMasterPageSize,
} from "@/services/excel/candidate-master-sheet";
import {
  getCandidateMasterSheetSchema,
  queryCandidateMasterSheetPage,
} from "@/services/persistence/candidate-master-sheet-postgres";
import { listRecentCandidateSyncHistory } from "@/services/persistence/read-candidate-sync-history";

export const runtime = "nodejs";

function parsePageSize(raw: string | null): CandidateMasterPageSize {
  const n = Number(raw);
  if (CANDIDATE_MASTER_PAGE_SIZE_OPTIONS.includes(n as CandidateMasterPageSize)) {
    return n as CandidateMasterPageSize;
  }
  return DEFAULT_CANDIDATE_MASTER_PAGE_SIZE;
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
  const schemaOnly = searchParams.get("schema") === "1";
  const syncHistoryOnly = searchParams.get("syncHistory") === "1";

  try {
    if (schemaOnly) {
      const schema = await getCandidateMasterSheetSchema();
      return NextResponse.json({ ok: true, schema });
    }

    if (syncHistoryOnly) {
      const syncHistory = await listRecentCandidateSyncHistory();
      return NextResponse.json({ ok: true, syncHistory });
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

    const result = await queryCandidateMasterSheetPage({
      page,
      pageSize,
      columnFilters,
      textFilters,
      dateFilters,
      highlightFilters,
      syncFilter,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Candidate Master Sheet could not be loaded.";
    console.error("[api/excel/candidate-master-sheet]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
