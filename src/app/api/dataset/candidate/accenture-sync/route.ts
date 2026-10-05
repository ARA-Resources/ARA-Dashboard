/**
 * Candidate Master Sheet — Accenture Final Report upload endpoint.
 *
 * POST multipart/form-data, field "file": the raw Accenture Final Report
 * export (.xlsx). Mirrors /api/dataset/candidate/oorwin-sync/route.ts
 * exactly (same editor gate via the existing `/api/dataset/*` access rule,
 * same integrity-check step, same 200-for-any-completed-run / non-200-for-
 * request-level-problems convention) — only the parser/job underneath
 * differ. Always a real run (never dry-run) — the dry-run path is CLI-only
 * (scripts/candidate-accenture-upload.ts), for the first prod run's
 * preview, not part of this UI flow.
 */
import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/dal";
import { validateExcelBuffer } from "@/services/dataset/validate-excel";
import { invokeCandidateAccentureSync } from "@/services/candidate-processing/candidate-accenture-sync-job";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  const gate = await authorizeRequest(request);
  if (!gate.ok) return gate.response;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Expected multipart/form-data with a 'file' field." },
      { status: 400 }
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: "Missing 'file' field in the upload." },
      { status: 400 }
    );
  }

  const filename = file.name || "upload.xlsx";
  const lower = filename.toLowerCase();
  if (!lower.endsWith(".xlsx")) {
    return NextResponse.json(
      { ok: false, error: "Unsupported file type. Expected .xlsx." },
      { status: 400 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  const integrity = await validateExcelBuffer(buffer, filename, {
    password: process.env.ARA_CANDIDATE_EXCEL_PASSWORD || undefined,
  });
  if (!integrity.ok) {
    const status =
      integrity.errorCode === "ENCRYPTED_NO_PASSWORD" ||
      integrity.errorCode === "ENCRYPTED_WRONG_PASSWORD"
        ? 422
        : 400;
    return NextResponse.json({ ok: false, error: integrity.error }, { status });
  }

  const syncBuffer = integrity.decryptedBuffer ?? buffer;

  try {
    const result = await invokeCandidateAccentureSync(
      syncBuffer,
      filename,
      gate.user.email || gate.user.username
    );
    return NextResponse.json({ ok: result.result !== "failed", ...result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error during Accenture sync.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
