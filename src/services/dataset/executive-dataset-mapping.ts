/**
 * Confirmed Executive demand-sheet attachment naming pattern.
 *
 * Phase E7 cleanup (2026-09-11): this file used to also hold the abandoned
 * Base DS → Google Sheets "New Sheet" column-mapping machinery (Phase 4B —
 * superseded by the real Postgres pipeline, see
 * `src/services/executive-processing/executive-base-ds-mapping.ts`). That
 * machinery and every file that used it were deleted once the dependency
 * trace confirmed nothing live still referenced them. This function is the
 * one export live code still depends on
 * (`executive-excel-discovery.ts`, Phase E2) — kept, not deleted.
 *
 * BROADENED 2026-09-17: was hard-locked to `.xlsx` only. Executive's real
 * master workbook is `.xlsm`, and there is no confirmed reason the incoming
 * demand-sheet attachment itself couldn't arrive as `.xlsm`/`.xls` too — so
 * this now accepts all three, matching Lateral's own flexibility (Lateral
 * has no fixed filename and must already support all three).
 */

export function isExecutiveDsAttachmentName(filename: string): boolean {
  const base = filename.split(/[/\\]/).pop()?.trim() ?? "";
  return /^ATCI Exec DS_.+\.(xlsx|xlsm|xls)$/i.test(base);
}
