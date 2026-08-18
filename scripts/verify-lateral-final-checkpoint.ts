/**
 * Verify FINAL Lateral Gmail checkpoint gates (advance only on full SUCCESS).
 * Run: npx tsx scripts/verify-lateral-final-checkpoint.ts
 */
import {
  FINAL_CHECKPOINT_GATES,
  LATERAL_CHECKPOINT_PROCESSING_SUCCESS,
  evaluateFinalCheckpointGates,
} from "../src/services/lateral-processing/lateral-final-checkpoint";
import type { LateralPipelineSuccess } from "../src/services/lateral-processing/pipeline";
import { PIPELINE_SUCCESS_MESSAGE } from "../src/services/lateral-processing/pipeline";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(LATERAL_CHECKPOINT_PROCESSING_SUCCESS === "SUCCESS", "SUCCESS constant");
assert(FINAL_CHECKPOINT_GATES.length === 11, "11 gates");

const pending = {
  messageId: "msg-1",
  attachmentId: "att-1",
  receivedAt: "2026-08-13T03:00:00.000Z",
  receivedAtMs: 1_755_000_000_000,
  attachmentFilename: "Lateral Demand.xlsx",
  driveFileId: "drive-src-1",
};

function makePipeline(okSteps: number[]): LateralPipelineSuccess {
  return {
    ok: true,
    message: PIPELINE_SUCCESS_MESSAGE,
    sourceFile: "Lateral Demand.xlsx",
    sourceSheet: "ATCI DS",
    rowsImported: 10,
    newRequisitions: 1,
    reopenedRequisitions: 1,
    closedRequisitions: 1,
    activeUnchanged: 7,
    macroStatus: "skipped_superseded",
    finalMasterSheet: "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm",
    masterFileId: "master-file-id",
    finalSaveVerified: true,
    columnKValidated: true,
    lastUpdated: new Date().toISOString(),
    steps: okSteps.map((step) => ({
      step,
      name: `Step ${step}`,
      status: "ok" as const,
      at: new Date().toISOString(),
    })),
  };
}

const allSteps = [
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
];

const happy = evaluateFinalCheckpointGates({
  pending,
  gmailSyncOk: true,
  atciDsFound: true,
  masterWorkbookFound: true,
  pipeline: makePipeline(allSteps),
});
assert(happy.ok, `happy gates failed: ${happy.reasons.join("; ")}`);
for (const g of FINAL_CHECKPOINT_GATES) {
  assert(happy.gates[g] === true, `gate ${g}`);
}

// Fail if pipeline missing
const noPipeline = evaluateFinalCheckpointGates({
  pending,
  gmailSyncOk: true,
  atciDsFound: true,
  masterWorkbookFound: true,
  pipeline: null,
});
assert(!noPipeline.ok, "must fail without pipeline");
assert(!noPipeline.gates.new_sheet_refreshed, "new sheet gate false");
assert(!noPipeline.gates.final_xlsm_stored_on_drive, "xlsm gate false");

// Fail if reconcile validation step missing
const missingReconcile = evaluateFinalCheckpointGates({
  pending,
  gmailSyncOk: true,
  atciDsFound: true,
  masterWorkbookFound: true,
  pipeline: makePipeline([11, 12, 13, 14, 15, 16, 18, 19, 20, 23, 24]),
});
assert(!missingReconcile.ok, "fail without reconcile validate step");
assert(!missingReconcile.gates.jr_reconciliation_completed, "jr gate");

// Fail without Drive upload id
const noDrive = evaluateFinalCheckpointGates({
  pending: { ...pending, driveFileId: "" },
  gmailSyncOk: true,
  atciDsFound: true,
  masterWorkbookFound: true,
  pipeline: makePipeline(allSteps),
});
assert(!noDrive.ok && !noDrive.gates.excel_uploaded_to_drive, "fail no drive id");

// Fail without ATCI DS
const noAtci = evaluateFinalCheckpointGates({
  pending,
  gmailSyncOk: true,
  atciDsFound: false,
  masterWorkbookFound: true,
  pipeline: makePipeline(allSteps),
});
assert(!noAtci.ok && !noAtci.gates.atci_ds_found, "fail no ATCI DS");

// Fail non-xlsm master name
const badName = evaluateFinalCheckpointGates({
  pending,
  gmailSyncOk: true,
  atciDsFound: true,
  masterWorkbookFound: true,
  pipeline: {
    ...makePipeline(allSteps),
    finalMasterSheet: "Master.xlsx",
  },
});
assert(!badName.ok && !badName.gates.final_xlsm_stored_on_drive, "fail xlsx name");

console.log("verify-lateral-final-checkpoint: OK");
console.log(
  JSON.stringify(
    {
      gates: FINAL_CHECKPOINT_GATES,
      processingResult: LATERAL_CHECKPOINT_PROCESSING_SUCCESS,
      rule: "Advance ONLY after all 11 gates; store SUCCESS; else retry email",
    },
    null,
    2
  )
);
