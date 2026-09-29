import { NextResponse } from "next/server";
import { resolveCandidateAutoFetchFields } from "@/services/candidate-processing/candidate-auto-fetch";

export const runtime = "nodejs";

/**
 * Candidate Master Sheet — manual Add/Modify "Scan" action (migration 021).
 * Read-only: gated by the existing `/api/excel/*` -> viewer rule in
 * access.ts, same as this feature's other read endpoints. Reuses
 * resolveCandidateAutoFetchFields (candidate-auto-fetch.ts) unchanged, with
 * every Oorwin fallback null — if the JR ID isn't found in either table (or
 * a field is unusable there), that field comes back null and the form
 * leaves it for the user to fill manually.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const jr = searchParams.get("jr") ?? "";

  try {
    const result = await resolveCandidateAutoFetchFields(jr, {
      primarySkills: null,
      market: null,
      clientSpoc: null,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Job Requisition ID lookup failed.";
    console.error("[api/excel/candidate-master-sheet/jr-lookup]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
