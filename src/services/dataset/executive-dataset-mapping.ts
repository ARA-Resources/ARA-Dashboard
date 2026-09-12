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
 */

export function isExecutiveDsAttachmentName(filename: string): boolean {
  const base = filename.split(/[/\\]/).pop()?.trim() ?? "";
  return /^ATCI Exec DS_.+\.xlsx$/i.test(base);
}
