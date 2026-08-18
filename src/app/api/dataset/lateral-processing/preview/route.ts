import { NextResponse } from "next/server";
import { readLateralDataProcessingSetup } from "@/services/lateral-processing/setup-store";
import { readLateralDataForPreview } from "@/services/lateral-processing/data-reader";

export const runtime = "nodejs";

// Reading two large workbooks can take time — extend the timeout ceiling
export const maxDuration = 120;

export async function GET() {
  const setup = await readLateralDataProcessingSetup();
  if (!setup) {
    return NextResponse.json(
      {
        error:
          "Lateral Data Processing Setup is not configured. Complete the setup wizard first.",
      },
      { status: 400 }
    );
  }

  if (!setup.sourceWorkbook.fileId || !setup.masterWorkbook.fileId) {
    return NextResponse.json(
      {
        error:
          "Source workbook or master workbook is not selected in the setup. Reopen the setup wizard.",
      },
      { status: 400 }
    );
  }

  try {
    const result = await readLateralDataForPreview(setup);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to read workbook data.";
    const status = /OAuth|not connected|permission|forbidden/i.test(message)
      ? 401
      : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
