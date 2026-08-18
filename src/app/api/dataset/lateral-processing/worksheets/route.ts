import { NextResponse } from "next/server";
import { listWorkbookWorksheets } from "@/services/lateral-processing/setup-validation";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fileId = searchParams.get("fileId")?.trim() || "";
  const fileName = searchParams.get("fileName")?.trim() || "workbook.xlsx";

  if (!fileId) {
    return NextResponse.json({ error: "fileId is required." }, { status: 400 });
  }

  try {
    const worksheets = await listWorkbookWorksheets(fileId, fileName);
    return NextResponse.json({ worksheets });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to read worksheet names.";
    const status = /OAuth|not connected|permission|forbidden/i.test(message)
      ? 401
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
