/**
 * Verify: (1) Executive's Gmail file-type filter + attachment-name regex now
 * accept .xlsx/.xlsm/.xls, and (2) the Posted Sheet config repoint to the
 * master workbook's own Drive file ID, including the reader's graceful
 * (never-throw) skip when config is missing. No network, no I/O — the
 * "missing config" branch is exercised by clearing env vars, and the graceful
 * skip is provable without ever reaching Drive because the config-resolution
 * throw is caught before any network call is made.
 */
import { isExecutiveDsAttachmentName } from "../src/services/dataset/executive-dataset-mapping";
import {
  EXECUTIVE_EXCEL_EXTENSIONS,
  buildExecutiveExcelDiscoveryQuery,
} from "../src/services/executive-processing/executive-excel-discovery";
import { resolveExecutivePostedSheetDriveFileId } from "../src/services/executive-processing/executive-posted-sheet-config";
import { readExecutivePostedSheet } from "../src/services/executive-processing/executive-posted-sheet-reader";
import type { DatasetKeywordConfig } from "../src/types/dataset-setup";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function main() {
  // --- EXECUTIVE_EXCEL_EXTENSIONS broadened ---
  assert(
    JSON.stringify(EXECUTIVE_EXCEL_EXTENSIONS) === JSON.stringify(["xlsx", "xlsm", "xls"]),
    `must be exactly ["xlsx","xlsm","xls"], got ${JSON.stringify(EXECUTIVE_EXCEL_EXTENSIONS)}`
  );

  // --- isExecutiveDsAttachmentName accepts all three, case-insensitively ---
  assert(isExecutiveDsAttachmentName("ATCI Exec DS_16 Sep 26.xlsx") === true, "xlsx must match");
  assert(isExecutiveDsAttachmentName("ATCI Exec DS_16 Sep 26.xlsm") === true, "xlsm must match");
  assert(isExecutiveDsAttachmentName("ATCI Exec DS_16 Sep 26.xls") === true, "xls must match");
  assert(isExecutiveDsAttachmentName("ATCI Exec DS_16 Sep 26.XLSX") === true, "case-insensitive extension");
  assert(isExecutiveDsAttachmentName("ATCI Exec DS_16 Sep 26.pdf") === false, "unrelated extension must be rejected");
  assert(isExecutiveDsAttachmentName("ATCI Exec DS_16 Sep 26.docx") === false, "docx must be rejected");
  assert(isExecutiveDsAttachmentName("Some Other File.xlsx") === false, "wrong prefix must be rejected regardless of extension");

  // --- Gmail query file-type clause reflects all three extensions ---
  const keywords: DatasetKeywordConfig[] = [
    { value: "Exec", enabled: true, priority: 1, matchMode: "contains" },
  ];
  const query = buildExecutiveExcelDiscoveryQuery({ afterMs: Date.now(), keywords });
  assert(query.includes("filename:xlsx"), "query must include filename:xlsx");
  assert(query.includes("filename:xlsm"), "query must include filename:xlsm");
  assert(query.includes("filename:xls"), "query must include filename:xls");
  assert(query.includes('filename:"ATCI Exec DS_"'), "query must still hard-narrow on the confirmed filename prefix");

  // --- Posted Sheet config: repointed to the master workbook's file ID ---
  const savedMaster = process.env.ARA_EXECUTIVE_MASTER_DRIVE_FILE_ID;
  const savedOverride = process.env.ARA_EXECUTIVE_POSTED_SHEET_FILE_ID;
  try {
    delete process.env.ARA_EXECUTIVE_MASTER_DRIVE_FILE_ID;
    delete process.env.ARA_EXECUTIVE_POSTED_SHEET_FILE_ID;

    // No config at all -> resolver must throw (fail-loud, not a silent stale default)
    let threw = false;
    try {
      resolveExecutivePostedSheetDriveFileId();
    } catch {
      threw = true;
    }
    assert(threw, "with no config at all, resolver must throw rather than fall back to a stale hardcoded ID");

    // Master file ID configured -> Posted Sheet resolves to the SAME file
    process.env.ARA_EXECUTIVE_MASTER_DRIVE_FILE_ID = "1AamiJ0-AK9xKHzDvLTcY8ovVsXdeYE-O";
    assert(
      resolveExecutivePostedSheetDriveFileId() === "1AamiJ0-AK9xKHzDvLTcY8ovVsXdeYE-O",
      "must resolve to the master workbook's file ID when no override is set"
    );

    // Explicit override still wins (escape hatch preserved)
    process.env.ARA_EXECUTIVE_POSTED_SHEET_FILE_ID = "some-other-override-id";
    assert(
      resolveExecutivePostedSheetDriveFileId() === "some-other-override-id",
      "explicit ARA_EXECUTIVE_POSTED_SHEET_FILE_ID override must still take precedence"
    );
    delete process.env.ARA_EXECUTIVE_POSTED_SHEET_FILE_ID;

    // --- readExecutivePostedSheet: missing config is a graceful ok:false, never an uncaught throw ---
    delete process.env.ARA_EXECUTIVE_MASTER_DRIVE_FILE_ID;
    const result = await readExecutivePostedSheet();
    assert(result.ok === false, "missing config must surface as ok:false, not throw");
    if (!result.ok) {
      assert(
        result.reason.includes("not configured"),
        `reason should explain missing config, got: ${result.reason}`
      );
    }
  } finally {
    if (savedMaster === undefined) delete process.env.ARA_EXECUTIVE_MASTER_DRIVE_FILE_ID;
    else process.env.ARA_EXECUTIVE_MASTER_DRIVE_FILE_ID = savedMaster;
    if (savedOverride === undefined) delete process.env.ARA_EXECUTIVE_POSTED_SHEET_FILE_ID;
    else process.env.ARA_EXECUTIVE_POSTED_SHEET_FILE_ID = savedOverride;
  }

  console.log("verify-executive-file-type-broadening: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
