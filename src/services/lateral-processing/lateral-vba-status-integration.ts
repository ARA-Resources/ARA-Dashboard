/**
 * Lateral VBA ↔ Dataset status integration policy.
 *
 * SOURCE OF TRUTH for Job Status (Active | Closed | Reopen | New):
 *   ARA Dataset backend → Master Sheet Column K only.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THE DATASET BACKEND HANDLES
 * ─────────────────────────────────────────────────────────────────────────
 *   JR in New + Master, existing K ≠ Closed  → Column K = Active
 *   JR in New + Master, existing K = Closed  → Column K = Reopen + Date DD-MM-YYYY
 *   JR in Master, not in New                 → Column K = Closed (keep row)
 *   JR in New, not in Master                 → append row + Column K = New
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT REMAINS IN VBA (untouched modules / procedures)
 * ─────────────────────────────────────────────────────────────────────────
 *   UpdateTeamsBasedOnSkillsLateral   (Module5) — Team - Auto from skills
 *   UpdateTeamColumnSAPLateral        (Module4) — Team matching
 *   CountOtherSkillsMatches_Active    (Module6) — Allocation skill counts
 *   CountSAPSkillMatchesActive        (Module7) — SAP role counts
 *   FilterAndMatchJobsPosted          (Module2) — Posted Sheet
 *   Aging / Ageing2                   (Module3) — ageing columns
 *   Entire VBA project / .xlsm container — never removed or converted to xlsx
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CONFLICTING VBA (Module11 — UpdateJobRequisitionsStatusLateral)
 * ─────────────────────────────────────────────────────────────────────────
 *   Original Sub: Active/Closed on Master, writes "New"/blank on New Sheet,
 *   appends new rows by whole-row paste. No Reopen. No Column-K-only rule.
 *   That logic DUPLICATES and CONFLICTS with the Dataset status engine.
 *
 * HOW CONFLICTS ARE PREVENTED
 *   1. Dataset reconcile writes final statuses before Drive save.
 *   2. Pipeline does NOT run the conflicting status Sub blindly after reconcile.
 *   3. On confirm, Module11 is replaced with a SAFE STUB that keeps the same
 *      Sub name but does not modify Job Status, dates, or append rows — so a
 *      manual Excel run also cannot overwrite Dataset results.
 *   4. Other VBA modules are left intact (unrelated business logic preserved).
 */
import { MASTER_JOB_STATUS_COLUMN_K } from "@/services/lateral-processing/lateral-job-status-rules";

/** Conflicting status macro name (kept as entry point; body neutralized). */
export const LATERAL_CONFLICTING_STATUS_MACRO =
  "UpdateJobRequisitionsStatusLateral";

/** VBA module that hosts the conflicting Sub (oletools / VB_Name). */
export const LATERAL_STATUS_VBA_MODULE_NAME = "Module11";

export const STATUS_LOGIC_OWNER = "dataset_backend" as const;

export type StatusLogicOwner = typeof STATUS_LOGIC_OWNER;

/** Unrelated VBA procedures that remain callable / preserved. */
export const PRESERVED_UNRELATED_VBA_PROCEDURES = [
  "UpdateTeamsBasedOnSkillsLateral",
  "UpdateTeamColumnSAPLateral",
  "CountOtherSkillsMatches_Active",
  "CountSAPSkillMatchesActive",
  "FilterAndMatchJobsPosted",
  "Aging",
  "Ageing2",
] as const;

export interface VbaStatusIntegrationPolicy {
  statusLogicOwner: StatusLogicOwner;
  statusColumn: typeof MASTER_JOB_STATUS_COLUMN_K;
  conflictingMacro: typeof LATERAL_CONFLICTING_STATUS_MACRO;
  runConflictingStatusMacroAfterReconcile: false;
  neutralizeConflictingMacroBody: true;
  preserveUnrelatedVba: true;
  preserveXlsmVbaProject: true;
  preservedProcedures: typeof PRESERVED_UNRELATED_VBA_PROCEDURES;
}

export const VBA_STATUS_INTEGRATION_POLICY: VbaStatusIntegrationPolicy = {
  statusLogicOwner: STATUS_LOGIC_OWNER,
  statusColumn: MASTER_JOB_STATUS_COLUMN_K,
  conflictingMacro: LATERAL_CONFLICTING_STATUS_MACRO,
  runConflictingStatusMacroAfterReconcile: false,
  neutralizeConflictingMacroBody: true,
  preserveUnrelatedVba: true,
  preserveXlsmVbaProject: true,
  preservedProcedures: PRESERVED_UNRELATED_VBA_PROCEDURES,
};

/**
 * Safe Module11 body: same Sub name, no status/date/row writes.
 * Unrelated modules are not part of this string.
 */
export function buildSafeStatusMacroStubSource(): string {
  return [
    `Attribute VB_Name = "${LATERAL_STATUS_VBA_MODULE_NAME}"`,
    `Sub ${LATERAL_CONFLICTING_STATUS_MACRO}()`,
    ``,
    `    ' SAFE STUB — Job Status is owned by ARA Dataset backend.`,
    `    ' Required statuses (Active | Closed | Reopen | New) are written ONLY to`,
    `    ' Master Sheet Column K by the Dataset status engine.`,
    `    '`,
    `    ' This stub intentionally does NOT:`,
    `    '   - set Active / Closed / New / Reopen`,
    `    '   - update dates`,
    `    '   - append Master rows`,
    `    '   - write Job Status into New Sheet`,
    `    '`,
    `    ' Unrelated macros (Teams / Skills / Aging / Posted) remain in other modules.`,
    ``,
    `    MsgBox "Job Status is managed by ARA Dataset (Master Sheet Column K)." & vbCrLf & _`,
    `           "No VBA status changes were applied. Unrelated macros are unchanged.", vbInformation`,
    ``,
    `End Sub`,
    ``,
  ].join("\r\n");
}

/** True when VBA source still contains the old conflicting Active/Closed/append logic. */
export function vbaSourceLooksLikeConflictingStatusLogic(source: string): boolean {
  const s = source || "";
  if (!s.includes(LATERAL_CONFLICTING_STATUS_MACRO)) return false;
  const writesActive = /=\s*"Active"/i.test(s);
  const writesClosed = /=\s*"Closed"/i.test(s);
  const appends =
    /PasteSpecial/i.test(s) || /pasteRow\s*=/i.test(s) || /Rows\(pasteRow\)/i.test(s);
  const writesNewSheetStatus =
    /wsNew\.Cells\([^)]*colStatus\)\.Value\s*=\s*"New"/i.test(s) ||
    // Use [\s\S] instead of /s (dotAll) so this stays valid under tsconfig target ES2017.
    /Sheets\("New Sheet"\)[\s\S]*\.Value\s*=\s*"New"/i.test(s);
  return (writesActive && writesClosed) || appends || writesNewSheetStatus;
}

export function vbaSourceLooksLikeSafeStatusStub(source: string): boolean {
  const s = source || "";
  if (!s.includes(LATERAL_CONFLICTING_STATUS_MACRO)) return false;
  if (!/SAFE STUB/i.test(s)) return false;
  return !vbaSourceLooksLikeConflictingStatusLogic(s);
}
