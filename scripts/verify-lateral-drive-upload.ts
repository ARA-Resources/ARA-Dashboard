/**
 * Verify Lateral Drive upload stage rules (no network).
 * Run: npx tsx scripts/verify-lateral-drive-upload.ts
 */
import {
  assertLateralDriveVisibleFilename,
  deletePreviousLateralSourceFiles,
  LateralDriveUploadError,
  verifyLateralDriveUpload,
} from "../src/services/lateral-processing/lateral-drive-upload";
import { originalExcelFilenameForDrive } from "../src/services/lateral-processing/lateral-excel-discovery";
import {
  collectPreviousSourceFileIdsForCleanup,
  isProtectedLateralMasterWorkbook,
  shouldDeletePreviousSourceFile,
} from "../src/services/lateral-processing/lateral-source-drive-cleanup";
import { DEFAULT_LATERAL_MASTER_WORKBOOK_NAME } from "../src/types/lateral-processing-setup";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- Original visible filename exactly ---
const original = "ATCI Lateral DS AI MasterSheet Final 2026.xlsm";
assert(
  assertLateralDriveVisibleFilename(original) === original,
  "Drive visible name must equal original"
);
assert(
  originalExcelFilenameForDrive(original) === original,
  "must not add timestamps/UUIDs/processed/copy"
);
assert(
  assertLateralDriveVisibleFilename("folder/Report.xlsx") === "Report.xlsx",
  "basename only"
);

// Must not invent renamed forms
const forbiddenPatterns = [
  /\d{4}-\d{2}-\d{2}T/,
  /[0-9a-f]{8}-[0-9a-f]{4}-/i,
  /_processed\b/i,
  /\scopy$/i,
];
const visible = assertLateralDriveVisibleFilename(
  "Weekly ATCI Lateral Demand.xlsx"
);
for (const pattern of forbiddenPatterns) {
  assert(
    !pattern.test(visible),
    `must not introduce pattern ${pattern} into filename`
  );
}

// --- Previous-file ID collection (never includes new id; never bulk-folder) ---
assert(
  collectPreviousSourceFileIdsForCleanup({
    newDriveFileId: "XYZ789",
    previousSourceDriveFileId: "ABC123",
    sourceStateCurrentId: "ABC123",
    driveMetaFileId: "ABC123",
    pendingCleanupFileIds: ["OLD001"],
  }).join(",") === "ABC123,OLD001",
  "must collect unique previous source IDs only"
);
assert(
  !collectPreviousSourceFileIdsForCleanup({
    newDriveFileId: "XYZ789",
    previousSourceDriveFileId: "XYZ789",
  }).includes("XYZ789"),
  "must never target the newly uploaded File ID for cleanup"
);

// --- Master Workbook protection ---
assert(
  isProtectedLateralMasterWorkbook({
    fileId: "MASTER1",
    fileName: DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
    configuredMasterFileId: "MASTER1",
  }),
  "configured Master File ID must be protected"
);
assert(
  isProtectedLateralMasterWorkbook({
    fileId: "OTHER",
    fileName: DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
  }),
  "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm must be protected"
);
assert(
  !isProtectedLateralMasterWorkbook({
    fileId: "ABC123",
    fileName: "Weekly ATCI Lateral Demand.xlsx",
    configuredMasterFileId: "MASTER1",
  }),
  "ordinary source Excel must not be treated as Master"
);

assert(
  shouldDeletePreviousSourceFile({
    previousFileId: "ABC123",
    newFileId: "XYZ789",
    previousFileName: "Weekly ATCI Lateral Demand.xlsx",
    configuredMasterFileId: "MASTER1",
    configuredMasterFileName: DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
  }).delete,
  "previous source Excel may be deleted after new verify"
);

assert(
  !shouldDeletePreviousSourceFile({
    previousFileId: "MASTER1",
    newFileId: "XYZ789",
    previousFileName: DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
    configuredMasterFileId: "MASTER1",
  }).delete,
  "must refuse to delete Master Workbook"
);

assert(
  !shouldDeletePreviousSourceFile({
    previousFileId: "XYZ789",
    newFileId: "XYZ789",
    previousFileName: "Weekly ATCI Lateral Demand.xlsx",
  }).delete,
  "must refuse to delete the newly uploaded file"
);

// --- Verification rejects wrong visible name ---
async function main() {
  const drive = {
    files: {
      get: async () => ({
        data: {
          id: "file-1",
          name: "Weekly ATCI Lateral Demand_processed.xlsx",
          size: "100",
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          trashed: false,
          parents: ["folder-lateral"],
          webViewLink: "https://drive.example/file-1",
        },
      }),
    },
  } as never;

  let mismatch = false;
  try {
    await verifyLateralDriveUpload({
      drive,
      driveFileId: "file-1",
      expectedFilename: "Weekly ATCI Lateral Demand.xlsx",
      expectedFolderId: "folder-lateral",
      expectedSize: 100,
    });
  } catch (error) {
    mismatch =
      error instanceof LateralDriveUploadError &&
      error.code === "FILENAME_MISMATCH";
  }
  assert(mismatch, "must fail verify when Drive renamed the file");

  const driveOk = {
    files: {
      get: async () => ({
        data: {
          id: "file-2",
          name: "Weekly ATCI Lateral Demand.xlsx",
          size: "100",
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          trashed: false,
          parents: ["folder-lateral"],
          webViewLink: "https://drive.example/file-2",
        },
      }),
    },
  } as never;

  const ok = await verifyLateralDriveUpload({
    drive: driveOk,
    driveFileId: "file-2",
    expectedFilename: "Weekly ATCI Lateral Demand.xlsx",
    expectedFolderId: "folder-lateral",
    expectedSize: 100,
  });
  assert(ok.visibleFileName === "Weekly ATCI Lateral Demand.xlsx", "verified name");
  assert(ok.driveFileId === "file-2", "verified id");
  assert(ok.parents.includes("folder-lateral"), "must be in Lateral folder");

  // Wrong folder
  let wrongFolder = false;
  try {
    await verifyLateralDriveUpload({
      drive: {
        files: {
          get: async () => ({
            data: {
              id: "file-3",
              name: "Weekly ATCI Lateral Demand.xlsx",
              size: "100",
              mimeType:
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              trashed: false,
              parents: ["other-folder"],
              webViewLink: null,
            },
          }),
        },
      } as never,
      driveFileId: "file-3",
      expectedFilename: "Weekly ATCI Lateral Demand.xlsx",
      expectedFolderId: "folder-lateral",
    });
  } catch (error) {
    wrongFolder =
      error instanceof LateralDriveUploadError && error.code === "VERIFY_FAILED";
  }
  assert(wrongFolder, "must fail when file is not in Lateral destination folder");

  // --- Cleanup: delete previous by ID; never Master; never new file ---
  const deleted: string[] = [];
  const mockDrive = {
    files: {
      get: async ({ fileId }: { fileId: string }) => {
        if (fileId === "MASTER1") {
          return {
            data: {
              id: "MASTER1",
              name: DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
              trashed: false,
            },
          };
        }
        if (fileId === "ABC123") {
          return {
            data: {
              id: "ABC123",
              name: "Weekly ATCI Lateral Demand.xlsx",
              trashed: false,
            },
          };
        }
        if (fileId === "XYZ789") {
          return {
            data: {
              id: "XYZ789",
              name: "Weekly ATCI Lateral Demand.xlsx",
              trashed: false,
            },
          };
        }
        const err = Object.assign(new Error("Not Found"), { code: 404 });
        throw err;
      },
      delete: async ({ fileId }: { fileId: string }) => {
        deleted.push(fileId);
        return {};
      },
    },
  } as never;

  const cleanup = await deletePreviousLateralSourceFiles({
    drive: mockDrive,
    newDriveFileId: "XYZ789",
    previousFileIds: ["ABC123", "MASTER1", "XYZ789", "GONE404"],
    configuredMasterFileId: "MASTER1",
    configuredMasterFileName: DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
  });

  assert(deleted.includes("ABC123"), "must delete previous source ABC123");
  assert(!deleted.includes("MASTER1"), "must never delete Master Workbook");
  assert(!deleted.includes("XYZ789"), "must never delete newly uploaded file");
  assert(
    cleanup.deletedFileIds.includes("ABC123"),
    "ABC123 recorded as deleted"
  );
  assert(
    cleanup.deletedFileIds.includes("GONE404"),
    "404 previous file counts as cleaned"
  );
  assert(
    !cleanup.deletedFileIds.includes("MASTER1"),
    "Master must not be in deleted list"
  );

  // Delete failure → partial, keep new file (no throw)
  const failDrive = {
    files: {
      get: async () => ({
        data: {
          id: "ABC123",
          name: "Weekly ATCI Lateral Demand.xlsx",
          trashed: false,
        },
      }),
      delete: async () => {
        throw Object.assign(new Error("permission denied"), { code: 403 });
      },
    },
  } as never;
  const partial = await deletePreviousLateralSourceFiles({
    drive: failDrive,
    newDriveFileId: "XYZ789",
    previousFileIds: ["ABC123"],
  });
  assert(partial.partial, "cleanup failure must be partial success");
  assert(
    partial.pendingCleanupFileIds.includes("ABC123"),
    "failed delete must queue for retry"
  );

  console.log("verify-lateral-drive-upload: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
