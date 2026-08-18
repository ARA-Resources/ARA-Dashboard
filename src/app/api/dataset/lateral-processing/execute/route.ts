import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { readLateralDataProcessingSetup } from "@/services/lateral-processing/setup-store";
import { executeNewSheetUpdate } from "@/services/lateral-processing/new-sheet-writer";
import { stageMasterReconciliation } from "@/services/lateral-processing/master-reconcile";

export const runtime = "nodejs";

// New Sheet write + staged reconciliation can take several minutes
export const maxDuration = 300;

export async function POST() {
  const setup = await readLateralDataProcessingSetup();
  if (!setup) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Lateral Data Processing Setup is not configured. Complete the setup wizard first.",
      },
      { status: 400 }
    );
  }

  if (!setup.sourceWorkbook.fileId || !setup.masterWorkbook.fileId) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Source workbook or master workbook is not selected. Reopen the setup wizard.",
      },
      { status: 400 }
    );
  }

  try {
    // Phase A — populate New Sheet first.
    const newSheetResult = await executeNewSheetUpdate(setup, {
      commitToProduction: false,
    });
    if (!newSheetResult.ok) {
      const status =
        newSheetResult.phase === "column_mapping" ? 422 : 500;
      return NextResponse.json(newSheetResult, { status });
    }
    if (!newSheetResult.localEditedPath) {
      return NextResponse.json(
        {
          ok: false,
          phase: "write_new_sheet",
          error:
            "New Sheet update did not return a staged local workbook. Production Master was not modified.",
        },
        { status: 500 }
      );
    }

    // Phase B — stage Master reconciliation + report. Do NOT save to Drive yet.
    const reconcileResult = await stageMasterReconciliation(setup, {
      localWorkbookPath: newSheetResult.localEditedPath,
    });
    await fs.unlink(newSheetResult.localEditedPath).catch(() => undefined);
    if (!reconcileResult.ok) {
      return NextResponse.json(
        {
          ok: false,
          phase: "reconciliation",
          error: reconcileResult.error,
          rolledBack: reconcileResult.rolledBack,
          newSheet: newSheetResult,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      pendingSave: true,
      newSheet: newSheetResult,
      reconciliation: reconcileResult,
      report: reconcileResult.report,
      stagingId: reconcileResult.stagingId,
      masterFileId: reconcileResult.masterFileId,
      masterFileName: reconcileResult.masterFileName,
      message:
        `New Sheet updated (${newSheetResult.rowsWritten} rows). ` +
        `Reconciliation report ready — Confirm & Save to apply Master Sheet changes, or Cancel & Rollback.`,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unexpected error during Lateral processing.";
    const status = /OAuth|not connected|permission|forbidden/i.test(message)
      ? 401
      : 500;
    return NextResponse.json(
      { ok: false, phase: "execute", error: message, rolledBack: false },
      { status }
    );
  }
}
