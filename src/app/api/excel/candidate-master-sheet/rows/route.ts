import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/dal";
import {
  findLiveCandidateRowsByCid,
  insertCandidateManualRow,
  mergeManualValuesOntoExistingRow,
  updateCandidateManualRow,
  validateCandidateManualInput,
  type CandidateManualFieldValues,
} from "@/services/candidate-processing/candidate-manual-edit";
import { getCandidateMasterById } from "@/services/persistence/read-candidate-master";

export const runtime = "nodejs";

/**
 * Candidate Master Sheet — manual row Add (migration 021).
 *
 * GET  ?cid=<cid>  — duplicate pre-check (live rows sharing that CID), used
 *                    by the Add modal as the user types a CID, before Save.
 *                    Gated by the existing `/api/excel/*` -> viewer read rule.
 * POST             — Add. Gated by the new `access.ts` viewer-write rule —
 *                    the only viewer write surface in the app (see
 *                    access.ts's CANDIDATE_ROWS_PATH comment).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cid = searchParams.get("cid") ?? "";
  try {
    const rows = await findLiveCandidateRowsByCid(cid);
    return NextResponse.json({ ok: true, rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Duplicate check failed.";
    console.error("[api/excel/candidate-master-sheet/rows GET]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

interface AddRequestBody {
  values?: Record<string, string>;
  /** "add" = insert as a new duplicate row anyway. { existingId } = treat as the existing candidate (merge onto that row instead of inserting). Omitted = the server checks for a duplicate CID and returns 409 if one exists. */
  onDuplicate?: "add" | { existingId: number };
}

export async function POST(request: Request) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;

  let body: AddRequestBody;
  try {
    body = (await request.json()) as AddRequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  const raw = body.values ?? {};
  const actor = gate.user.email || gate.user.username;

  // "treat as existing" (option b): merge the raw entered values onto the
  // chosen row (blank entered field keeps that row's value), then run the
  // exact same diff/update path Modify uses — see candidate-manual-edit.ts.
  if (body.onDuplicate && typeof body.onDuplicate === "object") {
    const existingId = Number(body.onDuplicate.existingId);
    const existing = await getCandidateMasterById(existingId);
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: "The selected existing candidate row could not be found." },
        { status: 404 }
      );
    }
    const merged = mergeManualValuesOntoExistingRow(raw, existing);
    const validated = validateCandidateManualInput(merged);
    if (!validated.ok) {
      return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
    }
    const originalValues = Object.fromEntries(
      Object.keys(validated.values).map((field) => [
        field,
        (existing as unknown as Record<string, string>)[field],
      ])
    ) as CandidateManualFieldValues;
    const outcome = await updateCandidateManualRow(
      existingId,
      validated.values,
      validated.uncleanContactNumberRaw,
      originalValues,
      actor
    );
    if (outcome.status === "not_found") {
      return NextResponse.json({ ok: false, error: "Candidate row no longer exists." }, { status: 404 });
    }
    if (outcome.status === "stale") {
      return NextResponse.json(
        { ok: false, error: "This candidate row changed since it was loaded. Please retry.", current: outcome.current },
        { status: 409 }
      );
    }
    if (outcome.status === "no_change") {
      return NextResponse.json({ ok: false, error: "No fields differ from the existing row." }, { status: 400 });
    }
    if (outcome.status === "invalid") {
      return NextResponse.json({ ok: false, error: outcome.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, mode: "updated_existing", ...outcome.result });
  }

  const validated = validateCandidateManualInput(raw);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
  }

  if (body.onDuplicate !== "add") {
    const duplicates = await findLiveCandidateRowsByCid(validated.values.cid);
    if (duplicates.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "duplicate_cid",
          duplicates,
        },
        { status: 409 }
      );
    }
  }

  try {
    const result = await insertCandidateManualRow(
      validated.values,
      validated.uncleanContactNumberRaw,
      actor
    );
    return NextResponse.json({ ok: true, mode: "inserted", ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to add candidate.";
    console.error("[api/excel/candidate-master-sheet/rows POST]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
