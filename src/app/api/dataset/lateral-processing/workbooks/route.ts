import { NextResponse } from "next/server";
import {
  listDriveExcelWorkbooksByName,
  listExcelWorkbooksInFolder,
} from "@/services/lateral-processing/setup-validation";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const folderId = searchParams.get("folderId")?.trim() || "";
  const query = searchParams.get("query")?.trim() || "";

  if (!folderId && !query) {
    return NextResponse.json(
      { error: "Provide either folderId or query." },
      { status: 400 }
    );
  }

  try {
    const files = folderId
      ? await listExcelWorkbooksInFolder(folderId)
      : await listDriveExcelWorkbooksByName(query);
    return NextResponse.json({ files });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load workbooks.";
    const status = /OAuth|not connected|permission|forbidden/i.test(message)
      ? 401
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
