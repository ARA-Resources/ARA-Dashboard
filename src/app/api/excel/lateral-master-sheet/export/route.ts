import { NextResponse } from "next/server";
import { exportLateralMasterSheetXlsx } from "@/services/excel/read-lateral-master-sheet";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const refresh = searchParams.get("refresh") === "1";

  try {
    const exported = await exportLateralMasterSheetXlsx({
      bypassCache: refresh,
    });

    return new NextResponse(new Uint8Array(exported.buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${exported.fileName}"`,
        "Cache-Control": "no-store",
        "X-Export-Row-Count": String(exported.rowCount),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to export Lateral Master Sheet.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
