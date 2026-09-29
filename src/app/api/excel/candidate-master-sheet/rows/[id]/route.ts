import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/dal";
import {
  softDeleteCandidateManualRow,
  updateCandidateManualRow,
  validateCandidateManualInput,
  type CandidateManualFieldValues,
} from "@/services/candidate-processing/candidate-manual-edit";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Candidate Master Sheet — manual row Modify (PATCH) / soft Delete (DELETE)
 * by the row's real database id (migration 021 — selection is by checkbox
 * on the real id, never by CID, since CID is not unique).
 *
 * PATCH  — gated by the new access.ts viewer-write rule (same as Add).
 * DELETE — gated by the new access.ts admin rule.
 */

interface ModifyRequestBody {
  values?: Record<string, string>;
  /** The 16-field snapshot the client loaded when it opened the modal — used for the stale-edit guard. */
  original?: Record<string, string>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;

  const { id: idParam } = await context.params;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "Invalid row id." }, { status: 400 });
  }

  let body: ModifyRequestBody;
  try {
    body = (await request.json()) as ModifyRequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const validated = validateCandidateManualInput(body.values ?? {});
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
  }

  const actor = gate.user.email || gate.user.username;
  const original = (body.original ?? null) as CandidateManualFieldValues | null;

  try {
    const outcome = await updateCandidateManualRow(
      id,
      validated.values,
      validated.uncleanContactNumberRaw,
      original,
      actor
    );
    if (outcome.status === "not_found") {
      return NextResponse.json({ ok: false, error: "Candidate row not found." }, { status: 404 });
    }
    if (outcome.status === "stale") {
      return NextResponse.json(
        {
          ok: false,
          error: "This candidate row changed since it was loaded. Please review the latest values and retry.",
          current: outcome.current,
        },
        { status: 409 }
      );
    }
    if (outcome.status === "no_change") {
      return NextResponse.json({ ok: false, error: "No fields changed." }, { status: 400 });
    }
    if (outcome.status === "invalid") {
      return NextResponse.json({ ok: false, error: outcome.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, ...outcome.result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to modify candidate.";
    console.error("[api/excel/candidate-master-sheet/rows/[id] PATCH]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;

  const { id: idParam } = await context.params;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "Invalid row id." }, { status: 400 });
  }

  const actor = gate.user.email || gate.user.username;

  try {
    const result = await softDeleteCandidateManualRow(id, actor);
    if (!result) {
      return NextResponse.json({ ok: false, error: "Candidate row not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete candidate.";
    console.error("[api/excel/candidate-master-sheet/rows/[id] DELETE]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
