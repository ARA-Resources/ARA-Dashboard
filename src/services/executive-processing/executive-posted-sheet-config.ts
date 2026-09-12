/**
 * Executive Posted Sheet source location (Phase E6).
 *
 * Confirmed by the user (2026-09-11): a tab literally named "Posted Sheet"
 * inside a Drive-hosted .xlsm workbook — currently
 * "Copy of ATCI Exec Job Reqs Master Sheet 10 Sep 26.xlsm",
 * Drive file ID 1fe-rSMKlzJm5oWrMgOvoJmD60btG7Z7r.
 *
 * Resolution strategy (mirrors `lateral-master-workbook-discovery.ts`'s
 * established pattern for Lateral's own Master Workbook, which has the
 * identical "this file might get replaced" characteristic): resolve by a
 * CONFIGURED Drive file ID, not by filename — the filename is known to
 * change (it already carries a date, "10 Sep 26", same spirit as the daily
 * demand-sheet filename) so name-matching would be unreliable. The file ID
 * is expected to be far more stable in practice (Drive file IDs persist
 * across in-place edits/saves of the same file), but if the file is ever
 * fully REPLACED (deleted + a new file uploaded), it would get a new ID —
 * exactly the scenario Lateral already solved for its Master Workbook via a
 * configured, updatable ID rather than a magic hardcoded constant baked into
 * business logic.
 *
 * `ARA_EXECUTIVE_POSTED_SHEET_FILE_ID` lets an operator update this without a
 * code change if the file is ever replaced — same escape-hatch shape as the
 * confirmed `EXECUTIVE_NEW_SHEET_SPREADSHEET_ID_DEFAULT` pattern already used
 * elsewhere in this codebase for another Executive Google resource ID.
 *
 * Unlike Lateral's Master Workbook discovery, this module never restores a
 * trashed file or falls back to folder+name search — Posted Sheet is
 * read-only input here, so an inaccessible file is simply treated as
 * "unreadable" (skip + warn, never mass-update `posted`), never acted on.
 */

export const EXECUTIVE_POSTED_SHEET_TAB_NAME = "Posted Sheet" as const;

export const EXECUTIVE_POSTED_SHEET_DRIVE_FILE_ID_DEFAULT =
  "1fe-rSMKlzJm5oWrMgOvoJmD60btG7Z7r";

export function resolveExecutivePostedSheetDriveFileId(): string {
  const fromEnv = process.env.ARA_EXECUTIVE_POSTED_SHEET_FILE_ID?.trim();
  return fromEnv || EXECUTIVE_POSTED_SHEET_DRIVE_FILE_ID_DEFAULT;
}
