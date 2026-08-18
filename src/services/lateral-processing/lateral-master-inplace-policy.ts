/**
 * Master Workbook in-place identity policy.
 *
 * Single source of truth:
 *   Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm
 *
 * Never create a second Master. Never promote backups / "(1)" / "_updated"
 * copies to be the configured Master identity.
 */
import { DEFAULT_LATERAL_MASTER_WORKBOOK_NAME } from "@/types/lateral-processing-setup";

export const CANONICAL_LATERAL_MASTER_WORKBOOK_NAME =
  DEFAULT_LATERAL_MASTER_WORKBOOK_NAME;

/** Patterns that must never become the Master identity filename. */
const FORBIDDEN_MASTER_IDENTITY_PATTERNS: RegExp[] = [
  /\(\d+\)\s*\.xlsm$/i, // "...(1).xlsm"
  /_updated\b/i,
  /_processed\b/i,
  /_BACKUP_/i,
  /_RECONCILE_BACKUP_/i,
  /_FINAL_SAVE_BACKUP_/i,
];

export function resolveExpectedMasterFileName(
  configuredOrDiscovered?: string | null
): string {
  const name = configuredOrDiscovered?.trim();
  return name || CANONICAL_LATERAL_MASTER_WORKBOOK_NAME;
}

/**
 * True when a filename must never be treated as the Master Workbook identity
 * (duplicate / backup / processed variants).
 */
export function isForbiddenMasterIdentityFilename(fileName: string): boolean {
  const name = fileName.trim();
  if (!name) return true;
  return FORBIDDEN_MASTER_IDENTITY_PATTERNS.some((re) => re.test(name));
}

/**
 * Backup uploads may create a separate Drive file, but the backup filename
 * must never equal the Master identity name.
 */
export function assertSafeMasterBackupFilename(
  backupFileName: string,
  masterFileName?: string | null
): { ok: true } | { ok: false; error: string } {
  const backup = backupFileName.trim();
  const master = resolveExpectedMasterFileName(masterFileName);
  if (!backup) {
    return { ok: false, error: "Backup filename is empty." };
  }
  if (backup.toLowerCase() === master.toLowerCase()) {
    return {
      ok: false,
      error: `Backup filename must not equal Master identity "${master}".`,
    };
  }
  if (!/_BACKUP_|_RECONCILE_BACKUP_|_FINAL_SAVE_BACKUP_/i.test(backup)) {
    return {
      ok: false,
      error: `Backup filename "${backup}" must include a backup suffix (never a Master identity name).`,
    };
  }
  if (isForbiddenMasterIdentityFilename(master)) {
    return {
      ok: false,
      error: `Configured Master filename "${master}" is not a valid Master identity.`,
    };
  }
  return { ok: true };
}

/**
 * Post-update identity checks: same File ID, expected filename, XLSM, not a duplicate name.
 */
export function validateMasterInPlaceIdentity(options: {
  expectedFileId: string;
  actualFileId: string | null | undefined;
  expectedFileName: string;
  actualFileName: string | null | undefined;
}): { ok: true } | { ok: false; error: string } {
  const expectedId = options.expectedFileId.trim();
  const actualId = (options.actualFileId ?? "").trim();
  const expectedName = resolveExpectedMasterFileName(options.expectedFileName);
  const actualName = (options.actualFileName ?? "").trim();

  if (!expectedId) {
    return { ok: false, error: "Expected Master File ID is missing." };
  }
  if (!actualId) {
    return { ok: false, error: "Drive did not return a Master File ID after update." };
  }
  if (actualId !== expectedId) {
    return {
      ok: false,
      error: `Master File ID changed after update (expected ${expectedId}, got ${actualId}). In-place update required — never create a new Master.`,
    };
  }
  if (isForbiddenMasterIdentityFilename(actualName)) {
    return {
      ok: false,
      error: `Master filename "${actualName}" looks like a duplicate/backup. Expected identity "${expectedName}".`,
    };
  }
  if (actualName.toLowerCase() !== expectedName.toLowerCase()) {
    return {
      ok: false,
      error: `Master filename mismatch after in-place update: expected "${expectedName}", got "${actualName}".`,
    };
  }
  if (!/\.xlsm$/i.test(actualName)) {
    return {
      ok: false,
      error: `Master must remain XLSM after in-place update (got "${actualName}").`,
    };
  }
  return { ok: true };
}
