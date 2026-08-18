/**
 * FINAL Lateral Gmail checkpoint rules.
 *
 * The checkpoint may advance ONLY after the entire pipeline succeeds:
 *   1. Gmail email found
 *   2. Excel attachment found
 *   3. Excel downloaded
 *   4. Excel uploaded to Google Drive
 *   5. ATCI DS found
 *   6. Master Workbook found
 *   7. New Sheet successfully refreshed
 *   8. Job Requisition reconciliation completed
 *   9. Master Sheet Column K validated
 *  10. Master Workbook successfully saved
 *  11. Final XLSM successfully stored in Google Drive
 *
 * On ANY failure: do not advance — next scheduled run retries the email.
 */
import type { LateralGmailCheckpoint } from "@/types/lateral-gmail-checkpoint";
import { advanceLateralGmailCheckpoint } from "@/services/lateral-processing/lateral-gmail-checkpoint-store";
import type { LateralPendingCheckpointAdvance } from "@/services/lateral-processing/lateral-gmail-incremental-sync";
import type { LateralPipelineSuccess } from "@/services/lateral-processing/pipeline";

export const LATERAL_CHECKPOINT_PROCESSING_SUCCESS = "SUCCESS" as const;

export type LateralCheckpointProcessingResult =
  typeof LATERAL_CHECKPOINT_PROCESSING_SUCCESS;

export const FINAL_CHECKPOINT_GATES = [
  "gmail_email_found",
  "excel_attachment_found",
  "excel_downloaded",
  "excel_uploaded_to_drive",
  "atci_ds_found",
  "master_workbook_found",
  "new_sheet_refreshed",
  "jr_reconciliation_completed",
  "column_k_validated",
  "master_workbook_saved",
  "final_xlsm_stored_on_drive",
] as const;

export type FinalCheckpointGate = (typeof FINAL_CHECKPOINT_GATES)[number];

export interface FinalCheckpointEvidence {
  /** Pending email/upload from Gmail sync (not yet checkpointed) */
  pending: LateralPendingCheckpointAdvance | null;
  /** Sync completed without stop/failure for this pending item */
  gmailSyncOk: boolean;
  /** ATCI DS worksheet was read successfully */
  atciDsFound: boolean;
  /** Master XLSM discovered with Master Sheet + New Sheet */
  masterWorkbookFound: boolean;
  /** Full pipeline returned ok:true through final Drive store */
  pipeline: LateralPipelineSuccess | null;
}

export interface FinalCheckpointGateResult {
  ok: boolean;
  reasons: string[];
  gates: Record<FinalCheckpointGate, boolean>;
}

export function evaluateFinalCheckpointGates(
  evidence: FinalCheckpointEvidence
): FinalCheckpointGateResult {
  const reasons: string[] = [];
  const pending = evidence.pending;

  const gmail_email_found = Boolean(pending?.messageId?.trim());
  const excel_attachment_found = Boolean(pending?.attachmentId?.trim());
  const excel_downloaded =
    evidence.gmailSyncOk &&
    Boolean(pending?.attachmentFilename?.trim());
  const excel_uploaded_to_drive = Boolean(pending?.driveFileId?.trim());
  const atci_ds_found = evidence.atciDsFound === true;
  const master_workbook_found = evidence.masterWorkbookFound === true;

  const pipeline = evidence.pipeline;
  const steps = pipeline?.steps ?? [];
  const stepOk = (n: number) =>
    steps.some((s) => s.step === n && s.status === "ok");

  const new_sheet_refreshed =
    pipeline?.ok === true && stepOk(11) && stepOk(12) && stepOk(13);
  const jr_reconciliation_completed =
    pipeline?.ok === true &&
    stepOk(14) &&
    stepOk(15) &&
    stepOk(16) &&
    stepOk(17);
  const column_k_validated =
    pipeline?.ok === true && pipeline.columnKValidated === true;
  const master_workbook_saved =
    pipeline?.ok === true &&
    pipeline.finalSaveVerified === true &&
    stepOk(20) &&
    stepOk(23);
  const final_xlsm_stored_on_drive =
    pipeline?.ok === true &&
    Boolean(pipeline.masterFileId?.trim()) &&
    /\.xlsm$/i.test(pipeline.finalMasterSheet || "") &&
    stepOk(23) &&
    stepOk(24);

  const gates: Record<FinalCheckpointGate, boolean> = {
    gmail_email_found,
    excel_attachment_found,
    excel_downloaded,
    excel_uploaded_to_drive,
    atci_ds_found,
    master_workbook_found,
    new_sheet_refreshed,
    jr_reconciliation_completed,
    column_k_validated,
    master_workbook_saved,
    final_xlsm_stored_on_drive,
  };

  for (const gate of FINAL_CHECKPOINT_GATES) {
    if (!gates[gate]) {
      reasons.push(`Final checkpoint gate failed: ${gate}.`);
    }
  }

  if (!pending?.receivedAt?.trim() || pending.receivedAtMs == null) {
    reasons.push("Email timestamp missing — cannot advance checkpoint.");
  }

  return {
    ok: reasons.length === 0 && Object.values(gates).every(Boolean),
    reasons,
    gates,
  };
}

/**
 * Advance checkpoint ONLY when all final gates pass.
 * Stores SUCCESS result with required identity fields.
 */
export async function advanceFinalLateralGmailCheckpoint(
  evidence: FinalCheckpointEvidence
): Promise<
  | { ok: true; checkpoint: LateralGmailCheckpoint; gates: FinalCheckpointGateResult }
  | { ok: false; error: string; gates: FinalCheckpointGateResult }
> {
  const gates = evaluateFinalCheckpointGates(evidence);
  if (!gates.ok || !evidence.pending) {
    return {
      ok: false,
      error:
        "Lateral Gmail checkpoint NOT advanced. " +
        (gates.reasons.join(" ") || "Final pipeline gates incomplete."),
      gates,
    };
  }

  const pending = evidence.pending;
  const processedAt = new Date().toISOString();

  const checkpoint = await advanceLateralGmailCheckpoint({
    messageId: pending.messageId,
    attachmentId: pending.attachmentId,
    receivedAt: pending.receivedAt,
    receivedAtMs: pending.receivedAtMs,
    attachmentFilename: pending.attachmentFilename,
    driveFileId: pending.driveFileId,
    processedAt,
    processingResult: LATERAL_CHECKPOINT_PROCESSING_SUCCESS,
  });

  if (checkpoint.processingResult !== LATERAL_CHECKPOINT_PROCESSING_SUCCESS) {
    return {
      ok: false,
      error: "Checkpoint write did not persist processingResult=SUCCESS.",
      gates,
    };
  }

  return { ok: true, checkpoint, gates };
}
