import { NextResponse } from "next/server";
import { confirmReconciliationSave } from "@/services/lateral-processing/master-reconcile";

export const runtime = "nodejs";
// Final XLSM save + optional Excel VBA stub neutralization can take several minutes
export const maxDuration = 300;

export async function POST() {
  try {
    const result = await confirmReconciliationSave();
    if (!result.ok) {
      const phaseMsg =
        result.phase === "validation"
          ? "Final Master save validation failed. XLSM was not overwritten."
          : result.phase === "backup"
            ? "Backup before final save failed. XLSM was not overwritten."
            : result.phase === "macro"
              ? "Master Workbook status-safe finalize failed. Synchronization is NOT successful."
              : result.error;
      return NextResponse.json(
        {
          ...result,
          message: phaseMsg || result.error,
        },
        {
          status:
            result.phase === "macro" || result.phase === "save" ? 500 : 400,
        }
      );
    }
    const stubNote = result.macro.conflictingMacroNeutralized
      ? " Conflicting Module11 status logic neutralized to safe stub."
      : " Conflicting status macro was not executed (Dataset owns Column K).";
    return NextResponse.json({
      ...result,
      message:
        `Final XLSM Master Workbook saved successfully ("${result.masterFileName}").` +
        ` Job Status owned by Dataset backend (Column K).` +
        ` Backup: ${result.backupFileName || "(retained)"}.` +
        ` ${result.macro.macroName}: ${result.macro.result}` +
        ` (${result.macro.durationMs}ms).` +
        stubNote,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to confirm save.";
    const status = /OAuth|not connected|permission|forbidden/i.test(message)
      ? 401
      : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
