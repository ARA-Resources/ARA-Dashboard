/**
 * Verify VBA ↔ Dataset status integration policy.
 * Run: npx tsx scripts/verify-lateral-vba-status-integration.ts
 */
import {
  LATERAL_CONFLICTING_STATUS_MACRO,
  PRESERVED_UNRELATED_VBA_PROCEDURES,
  STATUS_LOGIC_OWNER,
  VBA_STATUS_INTEGRATION_POLICY,
  buildSafeStatusMacroStubSource,
  vbaSourceLooksLikeConflictingStatusLogic,
  vbaSourceLooksLikeSafeStatusStub,
} from "../src/services/lateral-processing/lateral-vba-status-integration";
import { MASTER_JOB_STATUS_COLUMN_K } from "../src/services/lateral-processing/lateral-job-status-rules";
import fs from "node:fs";
import path from "node:path";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(
  VBA_STATUS_INTEGRATION_POLICY.statusLogicOwner === STATUS_LOGIC_OWNER,
  "owner"
);
assert(
  VBA_STATUS_INTEGRATION_POLICY.statusColumn === MASTER_JOB_STATUS_COLUMN_K,
  "Column K"
);
assert(
  VBA_STATUS_INTEGRATION_POLICY.runConflictingStatusMacroAfterReconcile === false,
  "must not run conflicting macro after reconcile"
);
assert(
  VBA_STATUS_INTEGRATION_POLICY.neutralizeConflictingMacroBody === true,
  "must neutralize body"
);
assert(
  VBA_STATUS_INTEGRATION_POLICY.preserveXlsmVbaProject === true,
  "preserve xlsm"
);
assert(
  PRESERVED_UNRELATED_VBA_PROCEDURES.includes("UpdateTeamsBasedOnSkillsLateral"),
  "teams preserved"
);

const stub = buildSafeStatusMacroStubSource();
assert(stub.includes(LATERAL_CONFLICTING_STATUS_MACRO), "stub keeps Sub name");
assert(vbaSourceLooksLikeSafeStatusStub(stub), "stub is safe");
assert(!vbaSourceLooksLikeConflictingStatusLogic(stub), "stub not conflicting");

const legacyPath = path.join(
  process.cwd(),
  ".data",
  "vba-inspect",
  "lateral-mastersheet__Module11.bas"
);
if (fs.existsSync(legacyPath)) {
  const legacy = fs.readFileSync(legacyPath, "utf8");
  assert(
    vbaSourceLooksLikeConflictingStatusLogic(legacy),
    "legacy Module11 detected as conflicting"
  );
  assert(
    !vbaSourceLooksLikeSafeStatusStub(legacy),
    "legacy Module11 is not the safe stub"
  );
}

console.log("verify-lateral-vba-status-integration: OK");
console.log(
  JSON.stringify(
    {
      statusLogicOwner: STATUS_LOGIC_OWNER,
      remainsInVba: PRESERVED_UNRELATED_VBA_PROCEDURES,
      conflictingMacro: LATERAL_CONFLICTING_STATUS_MACRO,
      handledByDataset: [
        "Active",
        "Closed",
        "Reopen+date",
        "New+append",
        "Column K only",
      ],
      conflictPrevention: [
        "no Application.Run of conflicting status body after reconcile",
        "Module11 neutralized to safe stub when Excel VBA trust allows",
        "XLSM / other modules preserved",
      ],
    },
    null,
    2
  )
);
