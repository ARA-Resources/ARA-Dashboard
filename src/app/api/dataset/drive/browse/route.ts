import { NextResponse } from "next/server";
import { listDriveFolders } from "@/services/drive/folder";

export const runtime = "nodejs";

/**
 * Browse real Google Drive folders for Dataset setup pickers.
 * GET ?parentId=...  or  ?query=...
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const parentId = searchParams.get("parentId")?.trim() || undefined;
  const query = searchParams.get("query")?.trim() || undefined;

  try {
    const folders = await listDriveFolders({ parentId, query });
    return NextResponse.json(
      { folders },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list Drive folders.";
    const status = /OAuth|not connected|permission|forbidden/i.test(message)
      ? 401
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
