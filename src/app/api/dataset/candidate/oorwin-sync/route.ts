/**
 * Candidate Master Sheet — Oorwin sync upload endpoint.
 *
 * POST multipart/form-data, field "file": an Oorwin "Candidate Master
 * Tracker" export (.xls, .xlsx, or .xlsm). No existing file-upload route to
 * copy in this codebase — Lateral/Executive's own "manual sync" is a Gmail
 * scan, not a literal upload — so this is genuinely new.
 *
 * Access: falls under the existing `/api/dataset/*` -> editor rule in
 * access.ts, same convention as Lateral/Executive's own manual-sync
 * endpoints. No new access-matrix entry needed.
 *
 * Response status: 200 for any run the sync job actually completed
 * (success/partial/failed are all business outcomes carried in the body's
 * `result` field, same convention as /api/dataset/gmail/sync), matching
 * how a failed run still gets a candidate_sync_history row for audit
 * visibility. Non-200 is reserved for request-level problems (no file,
 * wrong type, failed integrity check) or a genuinely unexpected exception
 * before/outside the job itself.
 */
import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth/dal";
import { validateExcelBuffer } from "@/services/dataset/validate-excel";
import { invokeCandidateSync } from "@/services/candidate-processing/candidate-sync-job";

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

  const filename = file.name || "upload.xls";
  const lower = filename.toLowerCase();
  if (!lower.endsWith(".xls") && !lower.endsWith(".xlsx") && !lower.endsWith(".xlsm")) {
    return NextResponse.json(
      { ok: false, error: "Unsupported file type. Expected .xls, .xlsx, or .xlsm." },
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
    const result = await invokeCandidateSync(
      syncBuffer,
      filename,
      gate.user.email || gate.user.username
    );
    return NextResponse.json({ ok: result.result !== "failed", ...result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error during candidate sync.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
