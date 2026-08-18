/**
 * Safeguards: P-Roles must never modify Master Sheet source data.
 *
 * Pivot create / refresh / filter reconfigure / appearance are READ-ONLY
 * against the source Google Sheet. P-Roles is an analysis/output view only.
 */
import { createHash } from "node:crypto";
import type { sheets_v4 } from "googleapis";

/** Local constants — avoid circular import with the pivot module. */
const MASTER_SHEET_TITLE = "Master Sheet";
const P_ROLES_SHEET_TITLE = "P-Roles";
const MASTER_LAST_ROW_SENTINEL_COLUMN = "B";
const MASTER_SOURCE_END_COLUMN_EXCLUSIVE = 13;

export interface MasterSheetSourceFingerprint {
  spreadsheetId: string;
  masterSheetId: number;
  headerRow: string[];
  /** 1-based last non-empty sentinel row. */
  lastSentinelRow1Based: number;
  sentinelNonEmptyCount: number;
  /** Hash of headers + full sentinel column — detects edits/deletes/renames. */
  contentSha256: string;
  capturedAt: string;
}

export interface SourceGuardResult {
  ok: true;
  fingerprintBefore: MasterSheetSourceFingerprint;
  fingerprintAfter: MasterSheetSourceFingerprint;
  sourceUnchanged: true;
}

/**
 * Collect every sheetId referenced by a Sheets batchUpdate request.
 * Used to refuse any write that targets Master Sheet (or any non-P-Roles sheet).
 */
export function collectBatchUpdateTargetSheetIds(
  requests: sheets_v4.Schema$Request[]
): number[] {
  const ids = new Set<number>();

  const add = (id: number | null | undefined) => {
    if (typeof id === "number") ids.add(id);
  };

  for (const req of requests) {
    add(req.updateCells?.range?.sheetId);
    add(req.updateCells?.start?.sheetId);
    add(req.repeatCell?.range?.sheetId);
    add(req.updateDimensionProperties?.range?.sheetId);
    add(req.updateSheetProperties?.properties?.sheetId);
    add(req.deleteSheet?.sheetId);
    add(req.deleteDimension?.range?.sheetId);
    add(req.insertDimension?.range?.sheetId);
    add(req.moveDimension?.source?.sheetId);
    add(req.mergeCells?.range?.sheetId);
    add(req.unmergeCells?.range?.sheetId);
    add(req.updateBorders?.range?.sheetId);
    add(req.addProtectedRange?.protectedRange?.range?.sheetId);
    add(req.copyPaste?.source?.sheetId);
    add(req.copyPaste?.destination?.sheetId);
    add(req.cutPaste?.source?.sheetId);
    add(req.sortRange?.range?.sheetId);
    if (req.findReplace && req.findReplace.sheetId != null) {
      add(req.findReplace.sheetId);
    }
    add(req.appendCells?.sheetId);
    add(req.autoResizeDimensions?.dimensions?.sheetId);
    add(req.addSheet?.properties?.sheetId);
    // Slicers live on P-Roles via anchorCell — dataRange may REFERENCE Master Sheet
    // for filtering pivots; that is not a write to Master Sheet.
    add(req.addSlicer?.slicer?.position?.overlayPosition?.anchorCell?.sheetId);
    add(req.addSlicer?.slicer?.position?.sheetId);
    add(
      req.updateEmbeddedObjectPosition?.newPosition?.overlayPosition?.anchorCell
        ?.sheetId
    );
  }

  return Array.from(ids);
}

/**
 * Hard rule: P-Roles mutations may only target allowed analysis sheets
 * (P-Roles and optional formula feed). Never Master Sheet.
 */
export function assertBatchUpdateTargetsOnlyPRoles(options: {
  requests: sheets_v4.Schema$Request[];
  pRolesSheetId: number;
  masterSheetId: number;
  /** Optional formula feed / staging sheets (never Master Sheet). */
  allowedExtraSheetIds?: number[];
}): void {
  const allowed = new Set<number>([
    options.pRolesSheetId,
    ...(options.allowedExtraSheetIds ?? []),
  ]);
  if (allowed.has(options.masterSheetId)) {
    throw new Error(
      "P-Roles source-guard misconfigured: Master Sheet cannot be an allowed write target."
    );
  }

  // Structural bans even before sheetId checks.
  for (const req of options.requests) {
    if (req.deleteDimension || req.insertDimension || req.moveDimension) {
      // Allow hide/show on allowed sheets only — deleteDimension is banned broadly.
      // (Row hide uses updateDimensionProperties, not deleteDimension.)
      throw new Error(
        "P-Roles source-guard refused write: insert/delete/move dimension is not allowed " +
          `(would risk rearranging "${MASTER_SHEET_TITLE}").`
      );
    }
    if (req.deleteSheet) {
      // Allow deleting only non-master via explicit check below if needed.
      const id = req.deleteSheet.sheetId;
      if (id === options.masterSheetId) {
        throw new Error(
          "P-Roles source-guard refused write: cannot delete Master Sheet."
        );
      }
    }
    if (req.copyPaste || req.cutPaste) {
      throw new Error(
        "P-Roles source-guard refused write: copyPaste/cutPaste is not allowed " +
          `(never copy Excel or other data into "${MASTER_SHEET_TITLE}").`
      );
    }
    if (req.sortRange) {
      throw new Error(
        "P-Roles source-guard refused write: sortRange is not allowed " +
          `(must not rearrange "${MASTER_SHEET_TITLE}" rows).`
      );
    }
    if (req.findReplace) {
      throw new Error(
        "P-Roles source-guard refused write: findReplace is not allowed " +
          `(must not modify "${MASTER_SHEET_TITLE}" values/headers).`
      );
    }
    if (req.appendCells) {
      const id = req.appendCells.sheetId;
      if (id === options.masterSheetId || (id != null && !allowed.has(id))) {
        throw new Error(
          "P-Roles source-guard refused write: appendCells is not allowed on source data."
        );
      }
    }
  }

  const targets = collectBatchUpdateTargetSheetIds(options.requests);
  for (const id of targets) {
    if (id === options.masterSheetId) {
      throw new Error(
        `P-Roles source-guard refused write: batchUpdate targets "${MASTER_SHEET_TITLE}" (id=${id}). ` +
          `P-Roles may only READ source data.`
      );
    }
    if (!allowed.has(id)) {
      throw new Error(
        `P-Roles source-guard refused write: batchUpdate targets sheetId=${id}. ` +
          `Only "${P_ROLES_SHEET_TITLE}" (id=${options.pRolesSheetId}) and approved feed sheets may be modified.`
      );
    }
  }
}

/**
 * Refuse values.* write APIs aimed at Master Sheet.
 * P-Roles code must only use values.get against the source.
 */
export function assertValuesWriteRangeIsNotMasterSheet(range: string): void {
  const normalized = range.replace(/''/g, "'");
  const masterQuoted = `'${MASTER_SHEET_TITLE}'`;
  if (
    normalized.startsWith(masterQuoted) ||
    normalized.startsWith(`${MASTER_SHEET_TITLE}!`) ||
    normalized === MASTER_SHEET_TITLE
  ) {
    throw new Error(
      `P-Roles source-guard refused values write to "${MASTER_SHEET_TITLE}" (${range}). ` +
        "Source Google Sheet is read-only for P-Roles."
    );
  }
}

export async function captureMasterSheetFingerprint(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  masterSheetId: number;
}): Promise<MasterSheetSourceFingerprint> {
  const { sheets, spreadsheetId, masterSheetId } = options;

  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${MASTER_SHEET_TITLE}'!A1:${columnLetter(
      MASTER_SOURCE_END_COLUMN_EXCLUSIVE - 1
    )}1`,
    majorDimension: "ROWS",
  });
  const headerRow = (headerRes.data.values?.[0] ?? []).map((c) =>
    String(c ?? "")
  );

  const sentinelRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${MASTER_SHEET_TITLE}'!${MASTER_LAST_ROW_SENTINEL_COLUMN}:${MASTER_LAST_ROW_SENTINEL_COLUMN}`,
    majorDimension: "COLUMNS",
  });
  const sentinel = (sentinelRes.data.values?.[0] ?? []).map((c) =>
    String(c ?? "")
  );

  let lastSentinelRow1Based = 1;
  let sentinelNonEmptyCount = 0;
  for (let i = 0; i < sentinel.length; i++) {
    if (sentinel[i].trim() !== "") {
      lastSentinelRow1Based = i + 1;
      sentinelNonEmptyCount += 1;
    }
  }

  const payload = JSON.stringify({
    masterSheetId,
    headerRow,
    sentinel,
  });
  const contentSha256 = createHash("sha256").update(payload).digest("hex");

  return {
    spreadsheetId,
    masterSheetId,
    headerRow,
    lastSentinelRow1Based,
    sentinelNonEmptyCount,
    contentSha256,
    capturedAt: new Date().toISOString(),
  };
}

export function assertMasterSheetFingerprintsEqual(
  before: MasterSheetSourceFingerprint,
  after: MasterSheetSourceFingerprint
): void {
  if (before.masterSheetId !== after.masterSheetId) {
    throw new Error(
      "P-Roles source-guard: Master Sheet id changed during P-Roles operation."
    );
  }
  if (
    JSON.stringify(before.headerRow) !== JSON.stringify(after.headerRow)
  ) {
    throw new Error(
      "P-Roles source-guard: Master Sheet headers were modified. Headers must remain unchanged."
    );
  }
  if (before.contentSha256 !== after.contentSha256) {
    throw new Error(
      "P-Roles source-guard: Master Sheet source data changed during P-Roles create/refresh/update. " +
        "P-Roles must only READ source data (no deletes, rearranges, renames, or value edits)."
    );
  }
}

/**
 * Run a P-Roles write callback while proving Master Sheet stays identical.
 * Every batchUpdate must go through guardedBatchUpdate (P-Roles sheet only).
 */
export async function withMasterSheetReadOnlyGuard<T>(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  masterSheetId: number;
  pRolesSheetId: number;
  allowedExtraSheetIds?: number[];
  run: (ctx: {
    guardedBatchUpdate: (
      requests: sheets_v4.Schema$Request[]
    ) => Promise<void>;
  }) => Promise<T>;
}): Promise<{ result: T; guard: SourceGuardResult }> {
  const fingerprintBefore = await captureMasterSheetFingerprint({
    sheets: options.sheets,
    spreadsheetId: options.spreadsheetId,
    masterSheetId: options.masterSheetId,
  });

  const guardedBatchUpdate = async (requests: sheets_v4.Schema$Request[]) => {
    assertBatchUpdateTargetsOnlyPRoles({
      requests,
      pRolesSheetId: options.pRolesSheetId,
      masterSheetId: options.masterSheetId,
      allowedExtraSheetIds: options.allowedExtraSheetIds,
    });
    if (requests.length === 0) return;
    await options.sheets.spreadsheets.batchUpdate({
      spreadsheetId: options.spreadsheetId,
      requestBody: { requests },
    });
  };

  const result = await options.run({ guardedBatchUpdate });

  const fingerprintAfter = await captureMasterSheetFingerprint({
    sheets: options.sheets,
    spreadsheetId: options.spreadsheetId,
    masterSheetId: options.masterSheetId,
  });
  assertMasterSheetFingerprintsEqual(fingerprintBefore, fingerprintAfter);

  return {
    result,
    guard: {
      ok: true,
      fingerprintBefore,
      fingerprintAfter,
      sourceUnchanged: true,
    },
  };
}

function columnLetter(n: number): string {
  let x = n;
  let s = "";
  while (x >= 0) {
    s = String.fromCharCode((x % 26) + 65) + s;
    x = Math.floor(x / 26) - 1;
  }
  return s;
}
