/**
 * Verify Lateral robust failure handling rules.
 * Run: npx tsx scripts/verify-lateral-failure-handling.ts
 */
import {
  LATERAL_FAILURE_CODES,
  assertNeverReportSuccessOnFailure,
  classifyLateralFailure,
  createLateralStageFailure,
} from "../src/services/lateral-processing/lateral-failure-handling";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(LATERAL_FAILURE_CODES.includes("GMAIL_AUTHENTICATION_FAILURE"), "auth");
assert(LATERAL_FAILURE_CODES.includes("ATCI_DS_MISSING"), "atci");
assert(LATERAL_FAILURE_CODES.includes("DUPLICATE_JR_IDS"), "dup");
assert(LATERAL_FAILURE_CODES.includes("XLSM_SAVE_FAILURE"), "xlsm");
assert(
  LATERAL_FAILURE_CODES.includes("GOOGLE_DRIVE_FINAL_UPDATE_FAILURE"),
  "final drive"
);

const f = createLateralStageFailure({
  code: "STATUS_RECONCILIATION_FAILURE",
  stage: "status_reconciliation",
  detail: "Column K invalid",
});
assert(f.ok === false, "ok false");
assert(f.checkpointAdvanced === false, "no checkpoint");
assert(f.previousMasterPreserved === true, "preserve master");
assert(f.retryable === true, "retryable");
assert(f.reportedSuccess === false, "no success");
assert(f.isHardFailure === true, "hard");
assert(f.failedStage.length > 0, "stage label");
assert(/Column K|reconcil/i.test(f.message), "human message");

const idle = createLateralStageFailure({
  code: "NO_MATCHING_EMAIL",
  stage: "gmail_email_match",
});
assert(idle.isHardFailure === false, "no mail is not hard failure");

assert(
  classifyLateralFailure({ error: "ATCI DS worksheet was not found" }).code ===
    "ATCI_DS_MISSING",
  "classify atci"
);
assert(
  classifyLateralFailure({
    error: "Duplicate Job Requisition ID JR-1",
    pipelineFailedStep: 14,
  }).code === "DUPLICATE_JR_IDS",
  "classify dup"
);
assert(
  classifyLateralFailure({
    syncItemStatus: "new_sheet_structure_failed",
    error: "header mismatch",
  }).code === "HEADER_MISMATCH",
  "classify header"
);
assert(
  classifyLateralFailure({
    error: "OAuth not connected",
  }).code === "GMAIL_AUTHENTICATION_FAILURE",
  "classify gmail auth"
);
assert(
  classifyLateralFailure({ pipelineFailedStep: 19, error: "P-Roles refresh failed" })
    .code === "P_ROLES_REFRESH_FAILURE",
  "classify p-roles step 19"
);
assert(
  classifyLateralFailure({ pipelineFailedStep: 24, error: "dest upload" })
    .code === "GOOGLE_DRIVE_FINAL_UPDATE_FAILURE",
  "classify step 24"
);

const guard = assertNeverReportSuccessOnFailure({
  hardFailure: f,
  checkpointAdvanced: false,
  claimedSuccess: true,
});
assert(!guard.ok, "must block success after hard failure");

const guardOk = assertNeverReportSuccessOnFailure({
  hardFailure: null,
  checkpointAdvanced: true,
  claimedSuccess: true,
});
assert(guardOk.ok, "success allowed without hard failure");

const guardCp = assertNeverReportSuccessOnFailure({
  hardFailure: f,
  checkpointAdvanced: true,
  claimedSuccess: false,
});
assert(!guardCp.ok, "must block checkpoint advance after hard failure");

console.log("verify-lateral-failure-handling: OK");
console.log(
  JSON.stringify(
    {
      codes: LATERAL_FAILURE_CODES,
      rules: [
        "stop",
        "no later stages",
        "no checkpoint",
        "preserve Master",
        "log stage",
        "human error",
        "retry next run",
        "never success on failure",
      ],
    },
    null,
    2
  )
);
