/**
 * Executive Posted Sheet source location (Phase E6).
 *
 * CORRECTED 2026-09-17: this module used to point at a standalone workbook,
 * "Copy of ATCI Exec Job Reqs Master Sheet 10 Sep 26.xlsm" (Drive file ID
 * 1fe-rSMKlzJm5oWrMgOvoJmD60btG7Z7r). That file was deleted by its owner and
 * replaced by the current master workbook ("Copy of ATCI Exec Job Reqs
 * Master Sheet 17 Sep 26.xlsm" at the time of this fix) — confirmed these
 * were never two parallel real systems, just one file that got replaced.
 * The "Posted Sheet" tab lives inside that same master workbook alongside
 * Master Sheet/New Sheet, so this module no longer carries its own separate
 * Drive file ID: it resolves to whatever `ARA_EXECUTIVE_MASTER_DRIVE_FILE_ID`
 * (`src/lib/config/runtime.ts`) already points at, removing the entire class
 * of "two files can silently drift apart" risk the old standalone-ID design
 * had. `ARA_EXECUTIVE_POSTED_SHEET_FILE_ID` remains as an optional override
 * escape hatch only, matching the same operator-override pattern used
 * elsewhere in this codebase — it should not normally be set.
 *
 * `getExecutiveMasterDriveFileId()` throws if
 * `ARA_EXECUTIVE_MASTER_DRIVE_FILE_ID` isn't configured. Callers of
 * {@link resolveExecutivePostedSheetDriveFileId} must not assume it never
 * throws — `executive-posted-sheet-reader.ts` wraps it and converts a throw
 * into its own typed `ok:false` result, preserving this pipeline's "missing
 * config is a skip, never a crash" contract.
 */
import { getExecutiveMasterDriveFileId } from "@/lib/config/runtime";

export const EXECUTIVE_POSTED_SHEET_TAB_NAME = "Posted Sheet" as const;

export function resolveExecutivePostedSheetDriveFileId(): string {
  const fromEnv = process.env.ARA_EXECUTIVE_POSTED_SHEET_FILE_ID?.trim();
  return fromEnv || getExecutiveMasterDriveFileId();
}
