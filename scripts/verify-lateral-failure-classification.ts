/**
 * Verify the classifyLateralFailure fix (2026-09-17): a signature/validation
 * failure whose message text happens to contain the word "header" (e.g.
 * "...expected ZIP/PK header.") must NOT be misclassified as a New Sheet
 * header-mismatch. Real incident: two Lateral "Run All" failures on
 * 2026-09-17 for "AdhocDS (Lateral Vendors) as on 17th Sep 2026.xlsx" (an
 * MS-OFFCRYPTO password-encrypted file) were reported under the stage
 * "New Sheet header structure" purely because of this text-matching bug.
 */
import { classifyLateralFailure } from "../src/services/lateral-processing/lateral-failure-handling";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// --- THE BUG: a ZIP/PK signature failure must classify as INVALID_EXCEL_FILE, not HEADER_MISMATCH ---
{
  const result = classifyLateralFailure({
    error: "Invalid Open XML Excel signature (expected ZIP/PK header).",
    syncItemStatus: "validation_failed",
  });
  assert(
    result.code === "INVALID_EXCEL_FILE" && result.stage === "excel_validation",
    `signature failure must classify as INVALID_EXCEL_FILE/excel_validation, got ${result.code}/${result.stage}`
  );
}

// --- A genuine header-mismatch (known status) must still classify correctly ---
{
  const result = classifyLateralFailure({
    error: "New Sheet header structure validation failed.",
    syncItemStatus: "new_sheet_structure_failed",
  });
  assert(
    result.code === "HEADER_MISMATCH" && result.stage === "header_structure",
    `genuine header mismatch (by status) must still classify as HEADER_MISMATCH, got ${result.code}/${result.stage}`
  );
}

// --- A genuine header-mismatch with NO known status (text-only fallback) must still work ---
{
  const result = classifyLateralFailure({
    error: 'New Sheet headers do not match the required exact A-J structure.',
  });
  assert(
    result.code === "HEADER_MISMATCH" && result.stage === "header_structure",
    `genuine header mismatch (by text fallback, no status) must still classify as HEADER_MISMATCH, got ${result.code}/${result.stage}`
  );
}

// --- Other statuses mentioning "header" incidentally must not be swept into HEADER_MISMATCH either ---
{
  const result = classifyLateralFailure({
    error: "Attachment too small to be a valid Excel file (missing OLE header bytes).",
    syncItemStatus: "download_failed",
  });
  assert(
    result.code !== "HEADER_MISMATCH",
    `an unrelated download failure mentioning "header" must not be misclassified as HEADER_MISMATCH, got ${result.code}`
  );
}

console.log("verify-lateral-failure-classification: OK");
