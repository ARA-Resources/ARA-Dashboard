import { NextResponse } from "next/server";
import { getCandidateChangeHistory } from "@/services/persistence/read-candidate-highlights";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ cid: string }>;
}

/**
 * Candidate Master Sheet — C10 full change history for one Candidate ID
 * (every field change ever recorded, across every sync — not filtered to
 * the most recent, unlike C9's highlight queries). Read-only: gated by the
 * existing `/api/excel/*` -> viewer rule in access.ts, same as the
 * Candidate Master Sheet's own data route, since anyone who can see the
 * sheet should be able to see a candidate's history.
 *
 * Optional `?masterId=` scopes history to the clicked row's
 * candidate_master.id — a CID can have more than one live row (migration
 * 021 never enforced uniqueness), and without this, two rows sharing a CID
 * have their independent histories merged and look duplicated. Missing or
 * invalid `masterId` falls back to today's cid-only behavior untouched.
 */
export async function GET(request: Request, context: RouteContext) {
  const { cid } = await context.params;

  const masterIdRaw = new URL(request.url).searchParams.get("masterId");
  let masterId: number | null = null;
  if (masterIdRaw !== null) {
    const parsed = Number(masterIdRaw);
    if (Number.isInteger(parsed) && parsed > 0) {
      masterId = parsed;
    }
  }

  try {
    const entries = await getCandidateChangeHistory(decodeURIComponent(cid), undefined, masterId);
    return NextResponse.json({ ok: true, cid, entries });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Candidate history could not be loaded.";
    console.error("[api/excel/candidate-master-sheet/[cid]/history]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
