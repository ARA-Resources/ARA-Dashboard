/**
 * Lateral Master Workbook discovery (read-only validation).
 *
 * Uses the configured Google Drive location to find the existing Master:
 *   "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm"
 *
 * Rules:
 * - Do NOT create a new Master Workbook
 * - Do NOT rename it
 * - Do NOT download / use a random .xlsx copy
 * - Must be .xlsm (VBA / macro-enabled)
 * - Validate exact worksheets "Master Sheet" and "New Sheet" exist
 * - Make NO workbook modifications during discovery
 *
 * On failure: caller must STOP — no Master edits, no Gmail checkpoint advance.
 */
import type { drive_v3 } from "googleapis";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import { listSourceWorkbookWorksheets } from "@/services/lateral-processing/lateral-source-workbook";
import {
  listExcelWorkbooksInFolder,
  listWorkbookWorksheets,
  resolveProcessingFolderId,
} from "@/services/lateral-processing/setup-validation";
import { readLateralDataProcessingSetup } from "@/services/lateral-processing/setup-store";
import {
  DEFAULT_LATERAL_MASTER_SHEET,
  DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
  DEFAULT_LATERAL_NEW_SHEET,
  resolvePipelineMasterWorkbook,
  type LateralDataProcessingSetup,
} from "@/types/lateral-processing-setup";

export class LateralMasterDiscoveryError extends Error {
  readonly code:
    | "NOT_CONFIGURED"
    | "NOT_FOUND"
    | "TRASHED"
    | "NOT_XLSM"
    | "NAME_MISMATCH"
    | "XLSX_REJECTED"
    | "SHEET_MISSING"
    | "VERIFY_FAILED";

  constructor(
    code: LateralMasterDiscoveryError["code"],
    message: string,
    readonly details?: {
      availableWorksheets?: string[];
      missingSheets?: string[];
      foundName?: string | null;
      folderId?: string | null;
    },
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "LateralMasterDiscoveryError";
    this.code = code;
  }
}

export interface LateralMasterDiscoveryResult {
  fileId: string;
  /** Exact Drive visible name — never renamed by us */
  fileName: string;
  mimeType: string | null;
  folderId: string | null;
  masterSheet: string;
  newSheet: string;
  availableWorksheets: string[];
  /** Confirmed present before any pipeline mutation */
  worksheetsValidated: true;
  /** True when the configured file was restored from Drive trash during discovery */
  restoredFromTrash?: boolean;
}

/** True only for macro-enabled Excel (.xlsm). */
export function isXlsmMasterFilename(fileName: string): boolean {
  return /\.xlsm$/i.test(fileName.trim());
}

/** Reject .xlsx / .xls stand-ins — Master must keep VBA. */
export function isRejectedNonMacroMasterCopy(fileName: string): boolean {
  const lower = fileName.trim().toLowerCase();
  if (lower.endsWith(".xlsm")) return false;
  return lower.endsWith(".xlsx") || lower.endsWith(".xls");
}

/**
 * Exact filename match for the configured Master Workbook.
 * Does not accept "Copy of …xlsx", renamed suffixes, or random demand exports.
 */
export function matchesConfiguredMasterFileName(
  foundName: string,
  expectedName: string
): boolean {
  return foundName.trim() === expectedName.trim();
}

export function resolveExpectedMasterFileName(
  setup:
    | Pick<LateralDataProcessingSetup, "masterWorkbook" | "processingMasterWorkbook">
    | null
    | undefined
): string {
  if (!setup) return DEFAULT_LATERAL_MASTER_WORKBOOK_NAME;
  const pipeline = resolvePipelineMasterWorkbook(setup);
  return pipeline.fileName || DEFAULT_LATERAL_MASTER_WORKBOOK_NAME;
}

/**
 * Validate Master Sheet + New Sheet exist by exact name before any changes.
 */
export const DEFAULT_LATERAL_POSTED_SHEET = "Posted Sheet";
export const DEFAULT_LATERAL_P_ROLES_SHEET = "P-Roles";

/**
 * Validate Posted Sheet + P-Roles exist before Posted / P-Roles pipeline steps.
 */
export function validatePipelineRequiredWorksheets(options: {
  availableWorksheets: string[];
  postedSheet?: string;
  pRolesSheet?: string;
}):
  | { ok: true; postedSheet: string; pRolesSheet: string }
  | { ok: false; missing: string[] } {
  const postedSheet =
    (options.postedSheet?.trim() || DEFAULT_LATERAL_POSTED_SHEET).trim();
  const pRolesSheet =
    (options.pRolesSheet?.trim() || DEFAULT_LATERAL_P_ROLES_SHEET).trim();
  const names = options.availableWorksheets;
  const missing: string[] = [];
  if (!names.includes(postedSheet)) missing.push(postedSheet);
  if (!names.includes(pRolesSheet)) missing.push(pRolesSheet);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, postedSheet, pRolesSheet };
}

export function validateMasterAndNewSheets(options: {
  availableWorksheets: string[];
  masterSheet?: string;
  newSheet?: string;
}): { ok: true; masterSheet: string; newSheet: string } | { ok: false; missing: string[] } {
  const masterSheet = (options.masterSheet?.trim() || DEFAULT_LATERAL_MASTER_SHEET).trim();
  const newSheet = (options.newSheet?.trim() || DEFAULT_LATERAL_NEW_SHEET).trim();
  const names = options.availableWorksheets;
  const missing: string[] = [];
  if (!names.includes(masterSheet)) missing.push(masterSheet);
  if (!names.includes(newSheet)) missing.push(newSheet);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, masterSheet, newSheet };
}

async function getDriveFileMeta(
  drive: drive_v3.Drive,
  fileId: string
): Promise<{
  id: string;
  name: string;
  mimeType: string | null;
  trashed: boolean;
  parents: string[];
} | null> {
  try {
    const res = await drive.files.get({
      fileId,
      fields: "id, name, mimeType, trashed, parents",
      supportsAllDrives: true,
    });
    if (!res.data.id || !res.data.name) return null;
    return {
      id: res.data.id,
      name: res.data.name,
      mimeType: res.data.mimeType ?? null,
      trashed: Boolean(res.data.trashed),
      parents: res.data.parents ?? [],
    };
  } catch {
    return null;
  }
}

/** Restore the exact configured Master Workbook from trash — never creates a substitute. */
async function restoreConfiguredMasterFromTrash(
  drive: drive_v3.Drive,
  fileId: string
): Promise<{
  id: string;
  name: string;
  mimeType: string | null;
  trashed: boolean;
  parents: string[];
}> {
  const restored = await drive.files.update({
    fileId,
    requestBody: { trashed: false },
    fields: "id, name, mimeType, trashed, parents",
    supportsAllDrives: true,
  });
  if (!restored.data.id || !restored.data.name) {
    throw new LateralMasterDiscoveryError(
      "TRASHED",
      `Configured Master Workbook (${fileId}) is in Google Drive trash and could not be restored. Restore it manually — do not create a new Master Workbook.`
    );
  }
  return {
    id: restored.data.id,
    name: restored.data.name,
    mimeType: restored.data.mimeType ?? null,
    trashed: Boolean(restored.data.trashed),
    parents: restored.data.parents ?? [],
  };
}

function assertXlsmMaster(fileName: string, expectedName: string): void {
  if (isRejectedNonMacroMasterCopy(fileName)) {
    throw new LateralMasterDiscoveryError(
      "XLSX_REJECTED",
      `Master Workbook must be an XLSM (VBA) file. Refusing non-macro copy "${fileName}".`
    );
  }
  if (!isXlsmMasterFilename(fileName)) {
    throw new LateralMasterDiscoveryError(
      "NOT_XLSM",
      `Master Workbook must be .xlsm because it contains VBA. Found: "${fileName}".`
    );
  }
  if (!matchesConfiguredMasterFileName(fileName, expectedName)) {
    throw new LateralMasterDiscoveryError(
      "NAME_MISMATCH",
      `Master Workbook name mismatch. Expected exact "${expectedName}", found "${fileName}". Do not rename or substitute another file.`,
      { foundName: fileName }
    );
  }
}

/**
 * Discover the existing Lateral Master Workbook on the COMMON Google Drive.
 * Read-only: never creates, renames, or writes the workbook.
 */
export async function discoverLateralMasterWorkbook(options?: {
  setup?: LateralDataProcessingSetup | null;
  drive?: drive_v3.Drive;
}): Promise<LateralMasterDiscoveryResult> {
  const setup =
    options?.setup === undefined
      ? await readLateralDataProcessingSetup()
      : options.setup;

  if (!setup) {
    throw new LateralMasterDiscoveryError(
      "NOT_CONFIGURED",
      "Lateral Dataset Setup is not configured — cannot discover Master Workbook."
    );
  }

  const expectedName = resolveExpectedMasterFileName(setup);
  const pipelineMaster = resolvePipelineMasterWorkbook(setup);
  const masterSheetName =
    setup.masterSheet?.trim() || DEFAULT_LATERAL_MASTER_SHEET;
  const newSheetName = setup.masterNewSheet?.trim() || DEFAULT_LATERAL_NEW_SHEET;
  const folderId = resolveProcessingFolderId(setup.sourceFolder) || null;

  let drive = options?.drive;
  if (!drive) {
    const client = await getAuthorizedGmailClient();
    drive = client.drive;
  }

  let candidate: {
    id: string;
    name: string;
    mimeType: string | null;
    folderId: string | null;
  } | null = null;
  let restoredFromTrash = false;

  // 1) Prefer the pipeline XLSM fileId (processingMasterWorkbook when primary is Google Sheet).
  const configuredId = pipelineMaster.fileId?.trim();
  if (configuredId) {
    let meta = await getDriveFileMeta(drive, configuredId);
    if (!meta) {
      throw new LateralMasterDiscoveryError(
        "NOT_FOUND",
        `Configured Master Workbook was not found on Google Drive (id=${configuredId}). Do not create a new Master Workbook.`
      );
    }
    if (meta.trashed) {
      meta = await restoreConfiguredMasterFromTrash(drive, configuredId);
      restoredFromTrash = true;
    }
    assertXlsmMaster(meta.name, expectedName);
    candidate = {
      id: meta.id,
      name: meta.name,
      mimeType: meta.mimeType,
      folderId: meta.parents[0] ?? folderId,
    };
  } else if (folderId) {
    // 2) Discover by exact name in the configured Drive folder — XLSM only.
    const workbooks = await listExcelWorkbooksInFolder(folderId);
    const exactXlsm = workbooks.filter(
      (file) =>
        matchesConfiguredMasterFileName(file.name, expectedName) &&
        isXlsmMasterFilename(file.name)
    );
    const xlsxTrap = workbooks.find(
      (file) =>
        isRejectedNonMacroMasterCopy(file.name) &&
        file.name.replace(/\.(xlsx|xls)$/i, "").toLowerCase() ===
          expectedName.replace(/\.xlsm$/i, "").toLowerCase()
    );
    if (exactXlsm.length === 0 && xlsxTrap) {
      throw new LateralMasterDiscoveryError(
        "XLSX_REJECTED",
        `Found "${xlsxTrap.name}" but Master Workbook must be XLSM (VBA). Do not download a random XLSX copy.`,
        { foundName: xlsxTrap.name, folderId }
      );
    }
    if (exactXlsm.length === 0) {
      throw new LateralMasterDiscoveryError(
        "NOT_FOUND",
        `Master Workbook "${expectedName}" was not found in the configured Google Drive location. Do not create a new Master Workbook.`,
        { folderId, foundName: null }
      );
    }
    // Deterministic if duplicates: prefer configured name exact + newest modifiedTime already sorted
    const hit = exactXlsm[0];
    candidate = {
      id: hit.id,
      name: hit.name,
      mimeType: hit.mimeType,
      folderId,
    };
  } else {
    throw new LateralMasterDiscoveryError(
      "NOT_CONFIGURED",
      "Master Workbook is not selected and no Google Drive source folder is configured for discovery."
    );
  }

  assertXlsmMaster(candidate.name, expectedName);

  // 3) Validate Master Sheet + New Sheet BEFORE any pipeline changes.
  let availableWorksheets: string[];
  try {
    availableWorksheets = await listWorkbookWorksheets(
      candidate.id,
      candidate.name
    );
  } catch (error) {
    throw new LateralMasterDiscoveryError(
      "VERIFY_FAILED",
      error instanceof Error
        ? `Failed to open Master Workbook worksheets: ${error.message}`
        : "Failed to open Master Workbook worksheets.",
      { foundName: candidate.name, folderId: candidate.folderId },
      error
    );
  }

  const sheets = validateMasterAndNewSheets({
    availableWorksheets,
    masterSheet: masterSheetName,
    newSheet: newSheetName,
  });

  if (!sheets.ok) {
    const missing = sheets.missing;
    const message =
      missing.length === 2
        ? `"${missing[0]}" and "${missing[1]}" worksheets were not found in the Master Workbook.`
        : `"${missing[0]}" worksheet was not found in the Master Workbook.`;
    throw new LateralMasterDiscoveryError(
      "SHEET_MISSING",
      message,
      {
        availableWorksheets,
        missingSheets: missing,
        foundName: candidate.name,
        folderId: candidate.folderId,
      }
    );
  }

  return {
    fileId: candidate.id,
    fileName: candidate.name,
    mimeType: candidate.mimeType,
    folderId: candidate.folderId,
    masterSheet: sheets.masterSheet,
    newSheet: sheets.newSheet,
    availableWorksheets,
    worksheetsValidated: true,
    restoredFromTrash: restoredFromTrash || undefined,
  };
}

/**
 * Local-path sheet validation helper (tests / offline). Never writes the file.
 */
export async function validateMasterWorkbookLocalFile(options: {
  localPath: string;
  expectedFileName?: string;
  masterSheet?: string;
  newSheet?: string;
}): Promise<{
  availableWorksheets: string[];
  masterSheet: string;
  newSheet: string;
}> {
  const expected =
    options.expectedFileName?.trim() || DEFAULT_LATERAL_MASTER_WORKBOOK_NAME;
  const baseName = options.localPath.split(/[/\\]/).pop() || "";
  if (baseName) {
    assertXlsmMaster(baseName, expected);
  } else if (!isXlsmMasterFilename(expected)) {
    throw new LateralMasterDiscoveryError(
      "NOT_XLSM",
      `Master Workbook must be .xlsm because it contains VBA.`
    );
  }

  const availableWorksheets = await listSourceWorkbookWorksheets(options.localPath);
  const sheets = validateMasterAndNewSheets({
    availableWorksheets,
    masterSheet: options.masterSheet,
    newSheet: options.newSheet,
  });
  if (!sheets.ok) {
    throw new LateralMasterDiscoveryError(
      "SHEET_MISSING",
      sheets.missing.length === 2
        ? `"${sheets.missing[0]}" and "${sheets.missing[1]}" worksheets were not found in the Master Workbook.`
        : `"${sheets.missing[0]}" worksheet was not found in the Master Workbook.`,
      { availableWorksheets, missingSheets: sheets.missing }
    );
  }
  return {
    availableWorksheets,
    masterSheet: sheets.masterSheet,
    newSheet: sheets.newSheet,
  };
}
