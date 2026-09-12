import { NextResponse } from "next/server";
import { buildMasterSheetXlsxBuffer } from "@/services/excel/build-master-sheet-xlsx";
import { exportExecutiveMasterSheetRows } from "@/services/persistence/executive-master-sheet-postgres";

export const runtime = "nodejs";

export async function GET() {
  try {
    const exported = await exportExecutiveMasterSheetRows();
    const buffer = await buildMasterSheetXlsxBuffer({
      sheetName: exported.sheetName,
      headers: exported.headers,
      rows: exported.rows,
    });

    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = `Executive-Master-Sheet-${stamp}.xlsx`;

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
        "X-Export-Row-Count": String(exported.rows.length),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to export Executive Master Sheet.";
    console.error("[api/excel/executive-master-sheet/export]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
