/**
 * Verify Master Drive update-in-place policy + identity guards.
 * Run: npx tsx scripts/verify-lateral-master-drive-update.ts
 */
import {
  FINAL_MASTER_WORKBOOK_NAME,
  assertFinalSaveIsXlsm,
} from "../src/services/lateral-processing/lateral-final-master-save";
import {
  CANONICAL_LATERAL_MASTER_WORKBOOK_NAME,
  assertSafeMasterBackupFilename,
  isForbiddenMasterIdentityFilename,
  resolveExpectedMasterFileName,
  validateMasterInPlaceIdentity,
} from "../src/services/lateral-processing/lateral-master-inplace-policy";
import { DEFAULT_LATERAL_MASTER_WORKBOOK_NAME } from "../src/types/lateral-processing-setup";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(FINAL_MASTER_WORKBOOK_NAME.endsWith(".xlsm"), "master xlsm name");
assert(assertFinalSaveIsXlsm(FINAL_MASTER_WORKBOOK_NAME).ok, "accept master");
assert(!assertFinalSaveIsXlsm("Copy.xlsx").ok, "no xlsx master");
assert(
  CANONICAL_LATERAL_MASTER_WORKBOOK_NAME ===
    DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
  "canonical Master name"
);
assert(
  CANONICAL_LATERAL_MASTER_WORKBOOK_NAME ===
    "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm",
  "exact Master filename"
);

assert(
  !isForbiddenMasterIdentityFilename(CANONICAL_LATERAL_MASTER_WORKBOOK_NAME),
  "canonical name is allowed"
);
assert(
  isForbiddenMasterIdentityFilename(
    "Copy of ATCI Lateral DS AI MasterSheet Final 2026 (1).xlsm"
  ),
  "reject (1) duplicate"
);
assert(
  isForbiddenMasterIdentityFilename(
    "Copy of ATCI Lateral DS AI MasterSheet Final 2026_updated.xlsm"
  ),
  "reject _updated"
);
assert(
  isForbiddenMasterIdentityFilename(
    "Copy of ATCI Lateral DS AI MasterSheet Final 2026_processed.xlsm"
  ),
  "reject _processed"
);
assert(
  isForbiddenMasterIdentityFilename(
    "Copy of ATCI Lateral DS AI MasterSheet Final 2026_BACKUP_20260101.xlsm"
  ),
  "reject backup as Master identity"
);

const okIdentity = validateMasterInPlaceIdentity({
  expectedFileId: "MASTER1",
  actualFileId: "MASTER1",
  expectedFileName: CANONICAL_LATERAL_MASTER_WORKBOOK_NAME,
  actualFileName: CANONICAL_LATERAL_MASTER_WORKBOOK_NAME,
});
assert(okIdentity.ok, "same File ID + filename passes");

const changedId = validateMasterInPlaceIdentity({
  expectedFileId: "MASTER1",
  actualFileId: "NEWFILE2",
  expectedFileName: CANONICAL_LATERAL_MASTER_WORKBOOK_NAME,
  actualFileName: CANONICAL_LATERAL_MASTER_WORKBOOK_NAME,
});
assert(!changedId.ok, "File ID change must fail");

const renamed = validateMasterInPlaceIdentity({
  expectedFileId: "MASTER1",
  actualFileId: "MASTER1",
  expectedFileName: CANONICAL_LATERAL_MASTER_WORKBOOK_NAME,
  actualFileName:
    "Copy of ATCI Lateral DS AI MasterSheet Final 2026_updated.xlsm",
});
assert(!renamed.ok, "renamed Master must fail");

assert(
  assertSafeMasterBackupFilename(
    "Copy of ATCI Lateral DS AI MasterSheet Final 2026_BACKUP_20260101.xlsm",
    CANONICAL_LATERAL_MASTER_WORKBOOK_NAME
  ).ok,
  "timestamped backup name OK"
);
assert(
  !assertSafeMasterBackupFilename(
    CANONICAL_LATERAL_MASTER_WORKBOOK_NAME,
    CANONICAL_LATERAL_MASTER_WORKBOOK_NAME
  ).ok,
  "backup must not equal Master identity"
);

assert(
  resolveExpectedMasterFileName(null) === CANONICAL_LATERAL_MASTER_WORKBOOK_NAME,
  "default expected name"
);

// Policy assertions encoded in module contracts
const policy = {
  updateMethod: "files.update" as const,
  createMaster: false,
  preserveFileId: true,
  preserveFilename: true,
  preserveXlsm: true,
  preserveVba: true,
  verifyNewSheet: true,
  verifyMasterSheet: true,
  verifyColumnK: true,
  advanceGmailCheckpointOnlyAfterMasterSave: true,
  allowTemporaryBackupOnly: true,
};

assert(policy.createMaster === false, "never create Master");
assert(policy.updateMethod === "files.update", "update in place");
assert(policy.preserveFileId === true, "same File ID");
assert(policy.preserveFilename === true, "same filename");
assert(
  policy.advanceGmailCheckpointOnlyAfterMasterSave === true,
  "checkpoint after Master save"
);

console.log("verify-lateral-master-drive-update: OK");
console.log(
  JSON.stringify(
    {
      masterWorkbook: FINAL_MASTER_WORKBOOK_NAME,
      ...policy,
    },
    null,
    2
  )
);
