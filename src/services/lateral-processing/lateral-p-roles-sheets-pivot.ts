/**
 * Lateral P-Roles Pivot Table on a native Google Sheet.
 *
 * Excel XLSM is REFERENCE only (structure). Pivot source = Google Sheet
 * "Master Sheet" data only — never local Excel bytes / Excel PivotCache.
 *
 * SOURCE SAFEGUARD: P-Roles is an analysis/output view. Create, refresh,
 * filter changes, and appearance updates READ Master Sheet only — they must
 * never delete/rearrange/rename/modify Master Sheet values or copy Excel into it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { sheets_v4 } from "googleapis";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import {
  assertMasterSheetFingerprintsEqual,
  captureMasterSheetFingerprint,
  withMasterSheetReadOnlyGuard,
  type SourceGuardResult,
} from "@/services/lateral-processing/lateral-p-roles-source-guard";

import { getLateralMasterDriveFileId } from "@/lib/config/runtime";

export const P_ROLES_SHEET_TITLE = "P-Roles";
export const MASTER_SHEET_TITLE = "Master Sheet";

/** Exact headers confirmed from Excel PivotTable1 / target Master Sheet. */
export const P_ROLES_FIELDS = {
  primarySkills: "Primary Skills",
  skillCategorization: "Skill Categorization",
  jobManagementLevel: "Job Management Level",
  jobStatus: "Job Status",
  posted: "Posted",
  marketMap: "Market Map",
} as const;

/** 0-based column offsets on Master Sheet A=0 … M=12 */
export const MASTER_COL = {
  skillCategorization: 4, // E
  primarySkills: 5, // F
  jobManagementLevel: 6, // G
  marketMap: 8, // I
  jobStatus: 10, // K
  posted: 12, // M
} as const;

/** Last exclusive column index for source A:M (13 columns). */
export const MASTER_SOURCE_END_COLUMN_EXCLUSIVE = 13;

/**
 * Sentinel column used to detect the last data row (0-based).
 * Job Requisition ID (column B) is present on every Master data row.
 */
export const MASTER_LAST_ROW_SENTINEL_COLUMN = "B";

export interface MasterSheetPivotSourceRange {
  sheetId: number;
  /** Inclusive start row (header row 0). */
  startRowIndex: number;
  /** Exclusive end row — covers header + all current data rows. */
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
  /** 1-based last data row including header (e.g. 22771). */
  lastRowNumber1Based: number;
  /** A1-style description for logging. */
  a1Notation: string;
  /** How the end row was determined. */
  resolution: "sentinel-column" | "full-width-scan" | "sheet-grid-fallback";
}

function colIndexToLetter(n: number): string {
  let x = n;
  let s = "";
  while (x >= 0) {
    s = String.fromCharCode((x % 26) + 65) + s;
    x = Math.floor(x / 26) - 1;
  }
  return s;
}

/**
 * Dynamically resolve the Master Sheet pivot source range from live Google Sheet data.
 * Never uses a permanently fixed A1:J500-style range.
 * Call again on refresh/update so newly added rows are included.
 */
export async function resolveMasterSheetPivotSourceRange(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  masterSheetId: number;
}): Promise<MasterSheetPivotSourceRange> {
  const { sheets, spreadsheetId, masterSheetId } = options;

  const startRowIndex = 0;
  const startColumnIndex = 0;
  const endColumnIndex = MASTER_SOURCE_END_COLUMN_EXCLUSIVE;

  // 1) Prefer sentinel column B (Job Requisition ID) — one value per data row.
  let lastRowIndexInclusive = 0; // at least header
  let resolution: MasterSheetPivotSourceRange["resolution"] = "sentinel-column";

  try {
    const sentinel = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${MASTER_SHEET_TITLE}'!${MASTER_LAST_ROW_SENTINEL_COLUMN}:${MASTER_LAST_ROW_SENTINEL_COLUMN}`,
      majorDimension: "COLUMNS",
    });
    const col = sentinel.data.values?.[0] ?? [];
    for (let i = 0; i < col.length; i++) {
      if (String(col[i] ?? "").trim() !== "") {
        lastRowIndexInclusive = i;
      }
    }
    if (col.length === 0) {
      throw new Error("empty sentinel");
    }
  } catch {
    // 2) Fall back to scanning A:M for any non-empty cell
    resolution = "full-width-scan";
    const block = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${MASTER_SHEET_TITLE}'!A:${colIndexToLetter(endColumnIndex - 1)}`,
      majorDimension: "ROWS",
    });
    const rows = block.data.values ?? [];
    lastRowIndexInclusive = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] ?? [];
      if (row.some((c) => String(c ?? "").trim() !== "")) {
        lastRowIndexInclusive = i;
      }
    }
    if (rows.length === 0) {
      // 3) Last resort: sheet grid rowCount (still dynamic per sheet properties)
      resolution = "sheet-grid-fallback";
      const meta = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: "sheets.properties",
      });
      const master = (meta.data.sheets ?? []).find(
        (s) => s.properties?.sheetId === masterSheetId
      );
      const gridRows = master?.properties?.gridProperties?.rowCount ?? 2;
      lastRowIndexInclusive = Math.max(1, gridRows - 1);
    }
  }

  // Exclusive end index must include the last data row.
  const endRowIndex = lastRowIndexInclusive + 1;
  if (endRowIndex < 2) {
    throw new Error(
      `Master Sheet appears to have no data rows for P-Roles source (endRowIndex=${endRowIndex}).`
    );
  }

  const lastRowNumber1Based = lastRowIndexInclusive + 1;
  const a1Notation = `'${MASTER_SHEET_TITLE}'!A1:${colIndexToLetter(
    endColumnIndex - 1
  )}${lastRowNumber1Based}`;

  return {
    sheetId: masterSheetId,
    startRowIndex,
    endRowIndex,
    startColumnIndex,
    endColumnIndex,
    lastRowNumber1Based,
    a1Notation,
    resolution,
  };
}

export const JML_COLUMN_ORDER = [
  "8-Associate Manager",
  "9-Team Lead/Consultant",
  "10-Senior Analyst",
  "11-Analyst",
  "12-Associate",
] as const;

/**
 * Extract leading integer prefix from a Job Management Level label.
 * "10-Senior Analyst" → 10; "Associate" → null.
 */
export function extractJobManagementLevelNumericPrefix(
  label: string
): number | null {
  const m = String(label ?? "")
    .trim()
    .match(/^(\d+)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compare Job Management Level labels by numeric prefix ascending.
 * Labels with a numeric prefix sort before non-numeric; ties break by text.
 */
export function compareJobManagementLevelsByNumericPrefix(
  a: string,
  b: string
): number {
  const na = extractJobManagementLevelNumericPrefix(a);
  const nb = extractJobManagementLevelNumericPrefix(b);
  if (na != null && nb != null && na !== nb) return na - nb;
  if (na != null && nb == null) return -1;
  if (na == null && nb != null) return 1;
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
}

/** Dynamic order for all distinct JML values (not a fixed 8–12 list). */
export function sortJobManagementLevelsByNumericPrefix(
  labels: string[]
): string[] {
  return Array.from(new Set(labels.map((s) => String(s ?? "").trim()).filter(Boolean))).sort(
    compareJobManagementLevelsByNumericPrefix
  );
}

/** Hidden formula feed: Master Sheet A:M + derived JML sort key (Master Sheet untouched). */
export const P_ROLES_FEED_SHEET_TITLE = "_P-Roles Feed";
/** 0-based column index of the derived numeric sort key on the feed sheet (column N). */
export const P_ROLES_FEED_JML_SORT_KEY_COL = 13;

/**
 * Excel PivotTable1 location starts at A5 with 3 page-filter rows above (rowPageCount=3).
 * Google equivalent: compact slicers in rows 1–4, pivot body at A5.
 */
export const P_ROLES_PIVOT_ANCHOR = { rowIndex: 4, columnIndex: 0 } as const;

const P_ROLES_FILTER_SLICER_TITLES = [
  P_ROLES_FIELDS.jobStatus,
  P_ROLES_FIELDS.posted,
  P_ROLES_FIELDS.marketMap,
] as const;

const STATE_PATH = path.join(
  process.cwd(),
  ".data",
  "lateral-p-roles-google-sheet.json"
);

export interface LateralPRolesSheetState {
  version: 1;
  /** Native Google Spreadsheet ID (Pivot host). Never the Master XLSM ID. */
  spreadsheetId: string;
  spreadsheetName: string;
  webViewLink: string | null;
  /** Source Drive XLSM used for initial conversion only (not pivot cache). */
  seededFromDriveFileId: string;
  /** Anchor cell of the single P-Roles pivot (avoid duplicates). */
  pivotAnchor?: { rowIndex: number; columnIndex: number } | null;
  createdAt: string;
  updatedAt: string;
  lastPivotAppliedAt: string | null;
  lastPivotRefreshedAt?: string | null;
}

export interface ApplyPRolesPivotResult {
  ok: true;
  spreadsheetId: string;
  spreadsheetName: string;
  webViewLink: string | null;
  masterSheetId: number;
  pRolesSheetId: number;
  mode: "created" | "updated" | "refreshed" | "unchanged";
  source: {
    sheetTitle: string;
    startRowIndex: number;
    startColumnIndex: number;
    endColumnIndex: number;
    endRowIndex: number | null;
    note: string;
  };
  pivot: {
    rows: string[];
    columns: string[];
    filters: string[];
    valueField: string;
    aggregation: "COUNTA";
    /** Filter options come from Master Sheet data (visibleByDefault). */
    filtersDynamicFromSource: true;
  };
  architecture: PRolesDataSourceArchitecture;
  createdNewSpreadsheet: boolean;
  duplicatePivotsRemoved: number;
  /** Proves Master Sheet source data was not modified by this P-Roles op. */
  sourceGuard: {
    masterSheetUnchanged: true;
    contentSha256: string;
    lastSentinelRow1Based: number;
    sentinelNonEmptyCount: number;
  };
}

export interface ExistingPRolesPivot {
  pRolesSheetId: number;
  rowIndex: number;
  columnIndex: number;
  pivot: sheets_v4.Schema$PivotTable;
}

export interface PRolesDataSourceArchitecture {
  ok: true;
  /** Native Google Spreadsheet that hosts P-Roles. */
  sourceSpreadsheetName: string;
  sourceSpreadsheetId: string;
  sourceSpreadsheetMimeType: string;
  /** Tab inside that spreadsheet that feeds the pivot. */
  sourceTab: string;
  /** Dynamic GridRange description (unbounded rows). */
  sourceRange: string;
  pivotReadsExcelWorkbook: false;
  pivotReadsExcelPivotTable: false;
  pivotUsesStaticCopiedCache: false;
  /** P-Roles ops must only READ Master Sheet; never mutate it. */
  masterSheetReadOnlyByPRoles: true;
  historicalSeedDriveFileId: string | null;
  historicalSeedNote: string;
}

async function readState(): Promise<LateralPRolesSheetState | null> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as LateralPRolesSheetState;
    if (!parsed?.spreadsheetId) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeState(next: LateralPRolesSheetState): Promise<void> {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(next, null, 2), "utf8");
}

function findSheet(
  ss: sheets_v4.Schema$Spreadsheet,
  title: string
): sheets_v4.Schema$Sheet | undefined {
  return (ss.sheets ?? []).find((s) => s.properties?.title === title);
}

/**
 * Ensure a native Google Spreadsheet exists for P-Roles.
 *
 * IMPORTANT ARCHITECTURE:
 * - Live pivot source = Master Sheet INSIDE the Google Spreadsheet only.
 * - Drive XLSM may be converted once to CREATE the Google Sheet (seed).
 * - After that, apply/update paths reuse the Google Sheet and never read XLSM
 *   as the pivot data source.
 * - Local Excel path is never opened for P-Roles runtime data.
 */
export async function ensureLateralPRolesGoogleSpreadsheet(options?: {
  sourceDriveFileId?: string;
  forceNewConversion?: boolean;
}): Promise<{
  spreadsheetId: string;
  spreadsheetName: string;
  webViewLink: string | null;
  createdNewSpreadsheet: boolean;
}> {
  const sourceId =
    options?.sourceDriveFileId?.trim() || getLateralMasterDriveFileId();
  const { drive } = await getAuthorizedGmailClient();

  if (!options?.forceNewConversion) {
    const existing = await readState();
    if (existing?.spreadsheetId) {
      try {
        const meta = await drive.files.get({
          fileId: existing.spreadsheetId,
          fields: "id,name,mimeType,trashed,webViewLink",
          supportsAllDrives: true,
        });
        if (
          !meta.data.trashed &&
          meta.data.mimeType === "application/vnd.google-apps.spreadsheet"
        ) {
          return {
            spreadsheetId: existing.spreadsheetId,
            spreadsheetName: meta.data.name || existing.spreadsheetName,
            webViewLink: meta.data.webViewLink ?? existing.webViewLink,
            createdNewSpreadsheet: false,
          };
        }
      } catch {
        // fall through to convert
      }
    }
  }

  const sourceMeta = await drive.files.get({
    fileId: sourceId,
    fields: "id,name,mimeType,parents",
    supportsAllDrives: true,
  });

  // If the provided ID is already a native Google Sheet, use it directly.
  if (sourceMeta.data.mimeType === "application/vnd.google-apps.spreadsheet") {
    const now = new Date().toISOString();
    await writeState({
      version: 1,
      spreadsheetId: sourceId,
      spreadsheetName: sourceMeta.data.name || "Lateral Google Sheet",
      webViewLink: null,
      seededFromDriveFileId: sourceId,
      createdAt: now,
      updatedAt: now,
      lastPivotAppliedAt: null,
    });
    const link = await drive.files.get({
      fileId: sourceId,
      fields: "webViewLink,name",
      supportsAllDrives: true,
    });
    return {
      spreadsheetId: sourceId,
      spreadsheetName: link.data.name || sourceMeta.data.name || "Lateral Google Sheet",
      webViewLink: link.data.webViewLink ?? null,
      createdNewSpreadsheet: false,
    };
  }

  const parent = sourceMeta.data.parents?.[0];
  const sheetName =
    "ATCI Lateral DS AI MasterSheet Final 2026 (Google Sheet — P-Roles)";

  const copied = await drive.files.copy({
    fileId: sourceId,
    requestBody: {
      name: sheetName,
      mimeType: "application/vnd.google-apps.spreadsheet",
      parents: parent ? [parent] : undefined,
    },
    supportsAllDrives: true,
    fields: "id,name,mimeType,webViewLink",
  });

  if (!copied.data.id) {
    throw new Error("Drive conversion to Google Sheet did not return an ID.");
  }
  if (copied.data.mimeType !== "application/vnd.google-apps.spreadsheet") {
    throw new Error(
      `Expected native Google Sheet after conversion, got ${copied.data.mimeType}`
    );
  }

  // Never point Master XLSM pipeline at this new ID.
  if (copied.data.id === sourceId) {
    throw new Error("Conversion unexpectedly reused the XLSM File ID.");
  }

  const now = new Date().toISOString();
  await writeState({
    version: 1,
    spreadsheetId: copied.data.id,
    spreadsheetName: copied.data.name || sheetName,
    webViewLink: copied.data.webViewLink ?? null,
    seededFromDriveFileId: sourceId,
    createdAt: now,
    updatedAt: now,
    lastPivotAppliedAt: null,
  });

  return {
    spreadsheetId: copied.data.id,
    spreadsheetName: copied.data.name || sheetName,
    webViewLink: copied.data.webViewLink ?? null,
    createdNewSpreadsheet: true,
  };
}

/**
 * Distinct non-empty values from a Master Sheet column (Google Sheet only).
 * Used only when a default selection must exclude a value (e.g. Excel hid Closed).
 * Prefer visibleByDefault:true when all current+future values should appear.
 */
export function distinctNonEmptySheetValues(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((s) => String(s ?? "").trim())
        .filter((s) => s.length > 0)
    )
  );
}

/** Read distinct values from one Master Sheet column (read-only). */
export async function readMasterSheetColumnDistinctValues(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  /** 0-based column index (A=0). */
  columnIndex: number;
}): Promise<string[]> {
  const col = colIndexToLetter(options.columnIndex);
  const res = await options.sheets.spreadsheets.values.get({
    spreadsheetId: options.spreadsheetId,
    range: `'${MASTER_SHEET_TITLE}'!${col}2:${col}`,
    majorDimension: "COLUMNS",
  });
  const raw = (res.data.values?.[0] ?? []).map((v) => String(v ?? ""));
  return distinctNonEmptySheetValues(raw);
}

/**
 * Excel Job Status page field hides "Closed" by default.
 * Build visible set from Google Sheet source values only — never invent statuses.
 * Closed is omitted only when it actually exists in source.
 */
export function jobStatusFilterSelectionFromSheetData(
  distinctStatuses: string[]
): string[] {
  return distinctNonEmptySheetValues(distinctStatuses).filter(
    (s) => s.toLowerCase() !== "closed"
  );
}

function buildPRolesPivotTable(options: {
  /** Pivot source = formula feed sheet (Master Sheet A:M + JML sort key). */
  source: MasterSheetPivotSourceRange;
  /**
   * Distinct Job Status values from Google Sheet Master Sheet to show by default
   * (Excel-like: Closed excluded when present in source).
   */
  jobStatusVisibleValues: string[];
  /**
   * Distinct JML labels from Google Sheet Master Sheet ONLY (never Excel screenshot).
   * Must include every level present in source (e.g. 12-Associate), sorted by numeric prefix.
   * Do not invent levels that are absent from source.
   */
  jmlColumnsInNumericOrder: string[];
}): sheets_v4.Schema$PivotTable {
  if (options.jmlColumnsInNumericOrder.length === 0) {
    throw new Error(
      "P-Roles JML column metadata is empty — expected distinct Job Management Level values from Google Sheet source."
    );
  }
  // Guard: metadata must be in numeric-prefix order (source-driven, not Excel screenshot-driven).
  const sorted = sortJobManagementLevelsByNumericPrefix(
    options.jmlColumnsInNumericOrder
  );
  if (
    JSON.stringify(sorted) !== JSON.stringify(options.jmlColumnsInNumericOrder)
  ) {
    throw new Error(
      "P-Roles JML valueMetadata must be sorted by numeric prefix (8<9<10<11<12<…)."
    );
  }
  // Feed sheet GridRange: A:N where N is derived numeric sort key (Master Sheet untouched).
  const source: sheets_v4.Schema$GridRange = {
    sheetId: options.source.sheetId,
    startRowIndex: options.source.startRowIndex,
    endRowIndex: options.source.endRowIndex,
    startColumnIndex: options.source.startColumnIndex,
    endColumnIndex: options.source.endColumnIndex,
  };

  // Match Excel page-field defaults: Job Status hides Closed; Posted/Market Map = All.
  const jobStatusCriteria: sheets_v4.Schema$PivotFilterCriteria =
    options.jobStatusVisibleValues.length > 0
      ? {
          visibleByDefault: false,
          visibleValues: options.jobStatusVisibleValues,
        }
      : { visibleByDefault: true };

  /**
   * Excel PivotTable1 structure (Google Sheet Master Sheet data only):
   * Rows: Primary Skills → Skill Categorization (tabular / repeatHeadings)
   * Columns: Job Management Level (+ column Grand Total)
   * Values: Count of Job Management Level
   * Filters: Job Status, Posted, Market Map
   *
   * Numeric sort-key column keeps 8 < 9 < 10 < 11 < 12 (Sheets would otherwise sort lexically).
   */
  return {
    source,
    rows: [
      {
        sourceColumnOffset: MASTER_COL.primarySkills,
        // Bottom Grand Total (Excel rowGrandTotals default on).
        // No per-skill intermediate totals for Skill Categorization (below).
        showTotals: true,
        sortOrder: "ASCENDING",
        repeatHeadings: true,
        label: P_ROLES_FIELDS.primarySkills,
      },
      {
        sourceColumnOffset: MASTER_COL.skillCategorization,
        showTotals: false,
        sortOrder: "ASCENDING",
        repeatHeadings: true,
        label: P_ROLES_FIELDS.skillCategorization,
      },
    ],
    columns: [
      {
        sourceColumnOffset: P_ROLES_FEED_JML_SORT_KEY_COL,
        showTotals: true,
        sortOrder: "ASCENDING",
        label: " ",
      },
      {
        sourceColumnOffset: MASTER_COL.jobManagementLevel,
        showTotals: false,
        sortOrder: "ASCENDING",
        valueMetadata: options.jmlColumnsInNumericOrder.map((name) => ({
          value: { stringValue: name },
          collapsed: false,
        })),
        label: P_ROLES_FIELDS.jobManagementLevel,
      },
    ],
    values: [
      {
        summarizeFunction: "COUNTA",
        sourceColumnOffset: MASTER_COL.jobManagementLevel,
        name: "Count of Job Management Level",
      },
    ],
    valueLayout: "HORIZONTAL",
    filterSpecs: [
      {
        columnOffsetIndex: MASTER_COL.jobStatus,
        filterCriteria: jobStatusCriteria,
      },
      {
        columnOffsetIndex: MASTER_COL.posted,
        filterCriteria: { visibleByDefault: true },
      },
      {
        columnOffsetIndex: MASTER_COL.marketMap,
        filterCriteria: { visibleByDefault: true },
      },
    ],
  };
}

/** Ensure pivot JML valueMetadata covers every distinct source level (read-only check). */
export function assertJmlMetadataCoversSource(options: {
  sourceLevels: string[];
  metadataLevels: string[];
}): void {
  const sourceSet = new Set(
    sortJobManagementLevelsByNumericPrefix(options.sourceLevels)
  );
  const metaSet = new Set(
    options.metadataLevels.map((s) => String(s ?? "").trim()).filter(Boolean)
  );
  const missing = [...sourceSet].filter((s) => !metaSet.has(s));
  if (missing.length > 0) {
    throw new Error(
      `P-Roles pivot omitted Job Management Level(s) that exist in Google Sheet source: ${missing.join(", ")}. ` +
        `SOURCE determines which levels exist — do not drop levels because Excel screenshots omit them.`
    );
  }
  const invented = [...metaSet].filter((s) => !sourceSet.has(s));
  if (invented.length > 0) {
    throw new Error(
      `P-Roles pivot invents Job Management Level(s) not in Google Sheet source: ${invented.join(", ")}.`
    );
  }
}

/**
 * Ensure hidden formula feed sheet exists (create only). Master Sheet untouched.
 */
async function ensurePRolesFeedSheetExists(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  masterSheetId: number;
  endRowIndex: number;
}): Promise<number> {
  const { sheets, spreadsheetId, masterSheetId, endRowIndex } = options;
  const lastRow1Based = Math.max(1, endRowIndex);

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties",
  });
  const existing = findSheet(meta.data, P_ROLES_FEED_SHEET_TITLE);
  if (existing?.properties?.sheetId != null) {
    return existing.properties.sheetId;
  }

  const fpBefore = await captureMasterSheetFingerprint({
    sheets,
    spreadsheetId,
    masterSheetId,
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: P_ROLES_FEED_SHEET_TITLE,
              hidden: true,
              gridProperties: {
                rowCount: Math.max(lastRow1Based + 100, 1000),
                columnCount: 20,
              },
            },
          },
        },
      ],
    },
  });
  assertMasterSheetFingerprintsEqual(
    fpBefore,
    await captureMasterSheetFingerprint({ sheets, spreadsheetId, masterSheetId })
  );

  const refreshed = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties",
  });
  const feed = findSheet(refreshed.data, P_ROLES_FEED_SHEET_TITLE);
  if (feed?.properties?.sheetId == null) {
    throw new Error(`Failed to create "${P_ROLES_FEED_SHEET_TITLE}" sheet.`);
  }
  return feed.properties.sheetId;
}

/**
 * Formula feed sheet: mirrors Master Sheet A:M by formula + derived JML sort key.
 * Never writes Master Sheet cells. Enables numeric pivot column order.
 */
async function writePRolesFeedFormulas(options: {
  feedSheetId: number;
  endRowIndex: number;
  guardedBatchUpdate: (
    requests: sheets_v4.Schema$Request[]
  ) => Promise<void>;
}): Promise<{ sheetId: number; a1Notation: string }> {
  const { feedSheetId, endRowIndex, guardedBatchUpdate } = options;
  const lastRow1Based = Math.max(1, endRowIndex);

  await guardedBatchUpdate([
    {
      updateSheetProperties: {
        properties: {
          sheetId: feedSheetId,
          hidden: true,
        },
        fields: "hidden",
      },
    },
  ]);

  const mirrorFormula = `={'${MASTER_SHEET_TITLE}'!A1:M${lastRow1Based}}`;
  const sortKeyFormula = `=ARRAYFORMULA(IF(LEN(G2:G${lastRow1Based})=0,,IFERROR(VALUE(REGEXEXTRACT(TO_TEXT(G2:G${lastRow1Based}),"^(\\d+)")),1000000)))`;

  await guardedBatchUpdate([
    {
      updateCells: {
        rows: [
          {
            values: [{ userEnteredValue: { formulaValue: mirrorFormula } }],
          },
        ],
        start: {
          sheetId: feedSheetId,
          rowIndex: 0,
          columnIndex: 0,
        },
        fields: "userEnteredValue",
      },
    },
    {
      updateCells: {
        rows: [
          {
            values: [
              { userEnteredValue: { stringValue: "JML Sort Key" } },
            ],
          },
        ],
        start: {
          sheetId: feedSheetId,
          rowIndex: 0,
          columnIndex: P_ROLES_FEED_JML_SORT_KEY_COL,
        },
        fields: "userEnteredValue",
      },
    },
    {
      updateCells: {
        rows: [
          {
            values: [
              { userEnteredValue: { formulaValue: sortKeyFormula } },
            ],
          },
        ],
        start: {
          sheetId: feedSheetId,
          rowIndex: 1,
          columnIndex: P_ROLES_FEED_JML_SORT_KEY_COL,
        },
        fields: "userEnteredValue",
      },
    },
  ]);

  return {
    sheetId: feedSheetId,
    a1Notation: `'${P_ROLES_FEED_SHEET_TITLE}'!A1:N${lastRow1Based}`,
  };
}

/**
 * Polish sort-key header row after pivot render (do not write values into pivot cells).
 * Unhide the row so the native "Grand Total" caption is visible; camouflage numeric keys.
 */
async function polishPRolesColumnHeaders(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  pRolesSheetId: number;
  pivotRowIndex: number;
  guardedBatchUpdate: (
    requests: sheets_v4.Schema$Request[]
  ) => Promise<void>;
}): Promise<void> {
  const {
    sheets,
    spreadsheetId,
    pRolesSheetId,
    pivotRowIndex,
    guardedBatchUpdate,
  } = options;
  const sortKeyRow = pivotRowIndex + 1;

  await guardedBatchUpdate([
    {
      updateDimensionProperties: {
        range: {
          sheetId: pRolesSheetId,
          dimension: "ROWS",
          startIndex: sortKeyRow,
          endIndex: sortKeyRow + 1,
        },
        properties: { hiddenByUser: false, pixelSize: 26 },
        fields: "hiddenByUser,pixelSize",
      },
    },
  ]);

  const start1 = pivotRowIndex + 1;
  const grid = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: true,
    ranges: [`'${P_ROLES_SHEET_TITLE}'!A${start1}:Z${start1 + 3}`],
    fields: "sheets(data.rowData.values.formattedValue)",
  });
  const rows = grid.data.sheets?.[0]?.data?.[0]?.rowData ?? [];
  const sortKeyVals = (rows[1]?.values ?? []).map((c) =>
    String(c.formattedValue ?? "").trim()
  );
  const gtCol = sortKeyVals.findIndex((v) => v === "Grand Total");
  const requests: sheets_v4.Schema$Request[] = [];

  // Camouflage sort-key digits (formatting only — never userEnteredValue on pivot cells).
  for (let c = 0; c < Math.max(sortKeyVals.length, 14); c++) {
    if (c === gtCol) continue;
    const v = sortKeyVals[c] || "";
    if (!v || /^\d+$/.test(v) || v === " ") {
      requests.push({
        repeatCell: {
          range: {
            sheetId: pRolesSheetId,
            startRowIndex: sortKeyRow,
            endRowIndex: sortKeyRow + 1,
            startColumnIndex: c,
            endColumnIndex: c + 1,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.85, green: 0.85, blue: 0.85 },
              textFormat: {
                foregroundColor: { red: 0.85, green: 0.85, blue: 0.85 },
                fontSize: 1,
              },
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      });
    }
  }

  if (gtCol >= 0) {
    requests.push({
      repeatCell: {
        range: {
          sheetId: pRolesSheetId,
          startRowIndex: sortKeyRow,
          endRowIndex: sortKeyRow + 1,
          startColumnIndex: gtCol,
          endColumnIndex: gtCol + 1,
        },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
            backgroundColor: { red: 0.35, green: 0.35, blue: 0.35 },
            textFormat: {
              fontFamily: "Arial",
              fontSize: 10,
              bold: true,
              foregroundColor: { red: 1, green: 1, blue: 1 },
            },
          },
        },
        fields:
          "userEnteredFormat(horizontalAlignment,verticalAlignment,backgroundColor,textFormat)",
      },
    });
  }

  if (requests.length > 0) {
    await guardedBatchUpdate(requests);
  }
}

/** @deprecated Use polishPRolesColumnHeaders — kept name alias for call-site clarity during migrate. */
async function hidePRolesSortKeyHeaderRow(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  pRolesSheetId: number;
  pivotRowIndex: number;
  guardedBatchUpdate: (
    requests: sheets_v4.Schema$Request[]
  ) => Promise<void>;
}): Promise<void> {
  await polishPRolesColumnHeaders(options);
}

/**
 * Excel-like report filters on P-Roles: interactive slicers that apply to the Pivot Table.
 * dataRange REFERENCES the formula feed (Master Sheet values + sort key) — does not write Master Sheet.
 */
async function ensurePRolesReportFilterSlicers(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  feedSheetId: number;
  pRolesSheetId: number;
  pivotSource: MasterSheetPivotSourceRange;
  jobStatusHiddenValues: string[];
  guardedBatchUpdate: (
    requests: sheets_v4.Schema$Request[]
  ) => Promise<void>;
}): Promise<number> {
  const {
    sheets,
    spreadsheetId,
    feedSheetId,
    pRolesSheetId,
    pivotSource,
    jobStatusHiddenValues,
    guardedBatchUpdate,
  } = options;

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title),slicers)",
  });
  const pRoles = (meta.data.sheets ?? []).find(
    (s) => s.properties?.sheetId === pRolesSheetId
  );
  const existing = pRoles?.slicers ?? [];

  // Remove prior P-Roles filter slicers (by title) so we don't stack duplicates.
  const toDelete = existing.filter((s) => {
    const title = (s.spec?.title || "").trim();
    return (P_ROLES_FILTER_SLICER_TITLES as readonly string[]).includes(title);
  });
  if (toDelete.length > 0) {
    await guardedBatchUpdate(
      toDelete
        .map((s) => s.slicerId)
        .filter((id): id is number => typeof id === "number")
        .map((objectId) => ({ deleteEmbeddedObject: { objectId } }))
    );
  }

  const dataRange: sheets_v4.Schema$GridRange = {
    sheetId: feedSheetId,
    startRowIndex: pivotSource.startRowIndex,
    endRowIndex: pivotSource.endRowIndex,
    startColumnIndex: 0,
    endColumnIndex: P_ROLES_FEED_JML_SORT_KEY_COL + 1,
  };

  // Excel page fields sit stacked in A1:B3 (Job Status / Posted / Market Map).
  const slicerDefs: Array<{
    title: string;
    columnIndex: number;
    hiddenValues?: string[];
    rowIndex: number;
  }> = [
    {
      title: P_ROLES_FIELDS.jobStatus,
      columnIndex: MASTER_COL.jobStatus,
      hiddenValues: jobStatusHiddenValues,
      rowIndex: 0,
    },
    {
      title: P_ROLES_FIELDS.posted,
      columnIndex: MASTER_COL.posted,
      rowIndex: 1,
    },
    {
      title: P_ROLES_FIELDS.marketMap,
      columnIndex: MASTER_COL.marketMap,
      rowIndex: 2,
    },
  ];

  const requests: sheets_v4.Schema$Request[] = slicerDefs.map((def) => ({
    addSlicer: {
      slicer: {
        spec: {
          dataRange,
          columnIndex: def.columnIndex,
          applyToPivotTables: true,
          title: def.title,
          filterCriteria:
            def.hiddenValues && def.hiddenValues.length > 0
              ? { hiddenValues: def.hiddenValues }
              : undefined,
          textFormat: { bold: true, fontSize: 10, fontFamily: "Arial" },
          horizontalAlignment: "LEFT",
        },
        position: {
          overlayPosition: {
            anchorCell: {
              sheetId: pRolesSheetId,
              rowIndex: def.rowIndex,
              columnIndex: 0,
            },
            // Cover A:B like Excel's Job Status | (Multiple Items) filter row.
            widthPixels: 570,
            heightPixels: 36,
            offsetXPixels: 0,
            offsetYPixels: 0,
          },
        },
      },
    },
  }));

  await guardedBatchUpdate(requests);
  return requests.length;
}

/**
 * Sheet-level appearance tuned to Excel P-Roles (Aptos/Arial-like readability):
 * column widths, number format, alignment. Does NOT replace the live Pivot Table.
 */
export async function applyPRolesPivotAppearance(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  pRolesSheetId: number;
  /** When provided, writes go through the source-guard (P-Roles sheet only). */
  guardedBatchUpdate?: (
    requests: sheets_v4.Schema$Request[]
  ) => Promise<void>;
}): Promise<void> {
  const { sheets, spreadsheetId, pRolesSheetId, guardedBatchUpdate } = options;

  // Excel approx widths (chars → pixels): A~70, B~20, C–F~22, G~11
  const colWidthsPx = [
    420, // A Primary Skills
    150, // B Skill Categorization
    130, // C 8-Associate Manager
    150, // D 9-Team Lead/Consultant
    130, // E 10-Senior Analyst
    110, // F 11-Analyst
    110, // G 12-Associate
    100, // H Grand Total
  ];

  const requests: sheets_v4.Schema$Request[] = [];

  for (let i = 0; i < colWidthsPx.length; i++) {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId: pRolesSheetId,
          dimension: "COLUMNS",
          startIndex: i,
          endIndex: i + 1,
        },
        properties: { pixelSize: colWidthsPx[i] },
        fields: "pixelSize",
      },
    });
  }

  const headerStart = P_ROLES_PIVOT_ANCHOR.rowIndex;
  const dataStart = headerStart + 3;

  // Excel-like page-filter rows (Job Status / Posted / Market Map) above the pivot.
  if (headerStart > 0) {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId: pRolesSheetId,
          dimension: "ROWS",
          startIndex: 0,
          endIndex: Math.min(3, headerStart),
        },
        properties: { pixelSize: 36 },
        fields: "pixelSize",
      },
    });
  }
  if (headerStart > 3) {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId: pRolesSheetId,
          dimension: "ROWS",
          startIndex: 3,
          endIndex: headerStart,
        },
        properties: { pixelSize: 18 },
        fields: "pixelSize",
      },
    });
  }

  // Header band (pivot title + column headers): bold, wrap
  requests.push({
    repeatCell: {
      range: {
        sheetId: pRolesSheetId,
        startRowIndex: headerStart,
        endRowIndex: headerStart + 3,
        startColumnIndex: 0,
        endColumnIndex: 10,
      },
      cell: {
        userEnteredFormat: {
          textFormat: {
            fontFamily: "Arial",
            fontSize: 10,
            bold: true,
          },
          verticalAlignment: "MIDDLE",
          wrapStrategy: "WRAP",
        },
      },
      fields:
        "userEnteredFormat(textFormat,verticalAlignment,wrapStrategy)",
    },
  });

  // Row label columns A–B: left align, Arial 10
  requests.push({
    repeatCell: {
      range: {
        sheetId: pRolesSheetId,
        startRowIndex: dataStart,
        endRowIndex: dataStart + 5000,
        startColumnIndex: 0,
        endColumnIndex: 2,
      },
      cell: {
        userEnteredFormat: {
          textFormat: { fontFamily: "Arial", fontSize: 10, bold: false },
          horizontalAlignment: "LEFT",
          verticalAlignment: "MIDDLE",
        },
      },
      fields:
        "userEnteredFormat(textFormat,horizontalAlignment,verticalAlignment)",
    },
  });

  // Value columns C–H: center, integer-like counts (Excel count values)
  requests.push({
    repeatCell: {
      range: {
        sheetId: pRolesSheetId,
        startRowIndex: dataStart,
        endRowIndex: dataStart + 5000,
        startColumnIndex: 2,
        endColumnIndex: 8,
      },
      cell: {
        userEnteredFormat: {
          textFormat: { fontFamily: "Arial", fontSize: 10, bold: false },
          horizontalAlignment: "CENTER",
          verticalAlignment: "MIDDLE",
          numberFormat: { type: "NUMBER", pattern: "#,##0" },
        },
      },
      fields:
        "userEnteredFormat(textFormat,horizontalAlignment,verticalAlignment,numberFormat)",
    },
  });

  // Center the Job Management Level header labels
  requests.push({
    repeatCell: {
      range: {
        sheetId: pRolesSheetId,
        startRowIndex: headerStart + 1,
        endRowIndex: headerStart + 2,
        startColumnIndex: 2,
        endColumnIndex: 8,
      },
      cell: {
        userEnteredFormat: {
          horizontalAlignment: "CENTER",
          textFormat: { fontFamily: "Arial", fontSize: 10, bold: true },
        },
      },
      fields: "userEnteredFormat(horizontalAlignment,textFormat)",
    },
  });

  // Compact readable row height for pivot header area (title + sort-key + labels)
  requests.push({
    updateDimensionProperties: {
      range: {
        sheetId: pRolesSheetId,
        dimension: "ROWS",
        startIndex: headerStart,
        endIndex: headerStart + 3,
      },
      properties: { pixelSize: 28 },
      fields: "pixelSize",
    },
  });

  // Freeze pivot header rows (below compact report-filter slicers)
  requests.push({
    updateSheetProperties: {
      properties: {
        sheetId: pRolesSheetId,
        gridProperties: {
          frozenRowCount: P_ROLES_PIVOT_ANCHOR.rowIndex + 3,
          frozenColumnCount: 2,
        },
      },
      fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
    },
  });

  if (guardedBatchUpdate) {
    await guardedBatchUpdate(requests);
  } else {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }
}

async function ensurePRolesSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  ss: sheets_v4.Schema$Spreadsheet
): Promise<{ sheetId: number; spreadsheet: sheets_v4.Schema$Spreadsheet }> {
  const existing = findSheet(ss, P_ROLES_SHEET_TITLE);
  if (existing?.properties?.sheetId != null) {
    return { sheetId: existing.properties.sheetId, spreadsheet: ss };
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: P_ROLES_SHEET_TITLE,
              index: 1,
            },
          },
        },
      ],
    },
  });

  const refreshed = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties",
  });
  const created = findSheet(refreshed.data, P_ROLES_SHEET_TITLE);
  if (created?.properties?.sheetId == null) {
    throw new Error(`Failed to create "${P_ROLES_SHEET_TITLE}" sheet.`);
  }
  return { sheetId: created.properties.sheetId, spreadsheet: refreshed.data };
}

/**
 * Runtime enforcement: P-Roles pivot must read ONLY from the native Google Sheet.
 * Excel XLSM may exist historically as a one-time seed — never as live pivot source.
 */
export async function verifyPRolesDataSourceArchitecture(options?: {
  spreadsheetId?: string;
}): Promise<PRolesDataSourceArchitecture> {
  const state = await readState();
  const spreadsheetId =
    options?.spreadsheetId?.trim() || state?.spreadsheetId || "";
  if (!spreadsheetId) {
    throw new Error(
      "No Google Sheet configured for P-Roles. Cannot verify data-source architecture."
    );
  }

  const { sheets, drive } = await getAuthorizedGmailClient();

  const fileMeta = await drive.files.get({
    fileId: spreadsheetId,
    fields: "id,name,mimeType",
    supportsAllDrives: true,
  });
  if (fileMeta.data.mimeType !== "application/vnd.google-apps.spreadsheet") {
    throw new Error(
      `P-Roles host must be a native Google Sheet. Found mimeType=${fileMeta.data.mimeType} id=${spreadsheetId}`
    );
  }

  // Seed XLSM (if any) must be a different file and must not be the pivot host.
  const seedId = state?.seededFromDriveFileId?.trim() || null;
  if (seedId && seedId === spreadsheetId) {
    throw new Error(
      "P-Roles architecture violation: Google Sheet id equals historical XLSM seed id."
    );
  }

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties,dataSources",
  });

  if ((meta.data.dataSources ?? []).length > 0) {
    throw new Error(
      "P-Roles architecture violation: spreadsheet has connected dataSources (external connectors)."
    );
  }

  const titleById = new Map<number, string>();
  for (const s of meta.data.sheets ?? []) {
    if (s.properties?.sheetId != null && s.properties.title) {
      titleById.set(s.properties.sheetId, s.properties.title);
    }
  }

  const master = findSheet(meta.data, MASTER_SHEET_TITLE);
  if (master?.properties?.sheetId == null) {
    throw new Error(
      `Google Sheet is missing "${MASTER_SHEET_TITLE}" — required pivot source tab.`
    );
  }

  const pivotHost = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: true,
    ranges: [
      `'${P_ROLES_SHEET_TITLE}'!${String.fromCharCode(
        65 + P_ROLES_PIVOT_ANCHOR.columnIndex
      )}${P_ROLES_PIVOT_ANCHOR.rowIndex + 1}`,
      `'${P_ROLES_SHEET_TITLE}'!A1:Z80`,
    ],
    fields:
      "sheets(properties(sheetId,title),data.rowData.values.pivotTable)",
  });

  const pRoles = findSheet(pivotHost.data, P_ROLES_SHEET_TITLE);
  let pivot =
    pRoles?.data?.[0]?.rowData?.[0]?.values?.[0]?.pivotTable ?? null;
  // Fallback: scan grid for any native pivotTable (canonical or legacy A1).
  if (!pivot?.source) {
    const rows = pRoles?.data?.[0]?.rowData ?? [];
    outer: for (const row of rows) {
      for (const cell of row.values ?? []) {
        if (cell.pivotTable?.source) {
          pivot = cell.pivotTable;
          break outer;
        }
      }
    }
  }
  if (!pivot?.source || pivot.source.sheetId == null) {
    throw new Error(
      `P-Roles sheet has no live Pivot Table source on "${P_ROLES_SHEET_TITLE}".`
    );
  }

  const sourceTab = titleById.get(pivot.source.sheetId);
  const feedOk = sourceTab === P_ROLES_FEED_SHEET_TITLE;
  const masterOk = sourceTab === MASTER_SHEET_TITLE;
  if (!feedOk && !masterOk) {
    throw new Error(
      `P-Roles pivot source tab must be "${MASTER_SHEET_TITLE}" or formula feed "${P_ROLES_FEED_SHEET_TITLE}". Found "${sourceTab ?? pivot.source.sheetId}".`
    );
  }
  if (feedOk) {
    // Feed must be formula-linked to Master Sheet (not a static Excel dump).
    const feedProbe = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${P_ROLES_FEED_SHEET_TITLE}'!A1`,
      valueRenderOption: "FORMULA",
    });
    const formula = String(feedProbe.data.values?.[0]?.[0] ?? "");
    if (!formula.includes(MASTER_SHEET_TITLE)) {
      throw new Error(
        `P-Roles feed A1 must formula-reference "${MASTER_SHEET_TITLE}". Found: ${formula.slice(0, 120)}`
      );
    }
  } else if (pivot.source.sheetId !== master.properties.sheetId) {
    throw new Error(
      `P-Roles pivot source sheetId mismatch (expected ${master.properties.sheetId}, got ${pivot.source.sheetId}).`
    );
  }

  const expectedEndCol = feedOk
    ? P_ROLES_FEED_JML_SORT_KEY_COL + 1
    : MASTER_SOURCE_END_COLUMN_EXCLUSIVE;
  if (
    (pivot.source.startColumnIndex ?? 0) !== 0 ||
    pivot.source.endColumnIndex !== expectedEndCol
  ) {
    throw new Error(
      `P-Roles pivot source columns unexpected: start=${pivot.source.startColumnIndex} end=${pivot.source.endColumnIndex} (expected end=${expectedEndCol}).`
    );
  }

  // Dynamic row coverage: endRowIndex must cover current Master Sheet last data row.
  const liveRange = await resolveMasterSheetPivotSourceRange({
    sheets,
    spreadsheetId,
    masterSheetId: master.properties.sheetId,
  });
  const pivotEnd = pivot.source.endRowIndex;
  if (pivotEnd == null) {
    // Unbounded is acceptable (includes future rows without re-apply).
  } else if (pivotEnd < liveRange.endRowIndex) {
    throw new Error(
      `P-Roles pivot source is stale/fixed too short: pivot endRowIndex=${pivotEnd} but Master Sheet data ends at ${liveRange.endRowIndex}. Re-run apply/refresh.`
    );
  }

  // Confirm Master Sheet values are native sheet cells (spot-check, no IMPORT*).
  const formulaSample = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${MASTER_SHEET_TITLE}'!A1:M5`,
    valueRenderOption: "FORMULA",
  });
  const formulas = (formulaSample.data.values ?? [])
    .flat()
    .filter((c): c is string => typeof c === "string" && c.startsWith("="));
  const excelLike = formulas.filter((f) =>
    /importrange|importdata|excel|xlsm|drive\.google\.com\/file/i.test(f)
  );
  if (excelLike.length > 0) {
    throw new Error(
      `P-Roles architecture violation: Master Sheet contains Excel/import formulas: ${excelLike
        .slice(0, 3)
        .join(" | ")}`
    );
  }

  const startCol = pivot.source.startColumnIndex ?? 0;
  const endCol = pivot.source.endColumnIndex ?? MASTER_SOURCE_END_COLUMN_EXCLUSIVE;
  const displayTab = feedOk ? P_ROLES_FEED_SHEET_TITLE : MASTER_SHEET_TITLE;
  const sourceRange =
    pivotEnd == null
      ? `'${displayTab}'!${colIndexToLetter(startCol)}:${colIndexToLetter(
          endCol - 1
        )} (rows unbounded; values from ${MASTER_SHEET_TITLE})`
      : `'${displayTab}'!${colIndexToLetter(startCol)}1:${colIndexToLetter(
          endCol - 1
        )}${pivotEnd} (dynamic last-row through ${liveRange.lastRowNumber1Based}; values from ${MASTER_SHEET_TITLE} via formulas; resolution=${liveRange.resolution})`;

  return {
    ok: true,
    sourceSpreadsheetName:
      fileMeta.data.name || state?.spreadsheetName || "Google Sheet",
    sourceSpreadsheetId: spreadsheetId,
    sourceSpreadsheetMimeType: fileMeta.data.mimeType || "",
    sourceTab: `${MASTER_SHEET_TITLE}${feedOk ? ` (via ${P_ROLES_FEED_SHEET_TITLE} formulas + JML sort key)` : ""}`,
    sourceRange,
    pivotReadsExcelWorkbook: false,
    pivotReadsExcelPivotTable: false,
    pivotUsesStaticCopiedCache: false,
    masterSheetReadOnlyByPRoles: true,
    historicalSeedDriveFileId: seedId,
    historicalSeedNote: seedId
      ? "Drive XLSM was used only as a one-time conversion seed to create this Google Sheet. The live Pivot Table does not read that XLSM. P-Roles never modifies Master Sheet source data."
      : "No XLSM seed recorded. P-Roles never modifies Master Sheet source data.",
  };
}
/**
 * Find all Pivot Tables on the P-Roles sheet (scan a bounded region).
 * Prefer the anchor at A1 when multiple exist.
 */
export async function findExistingPRolesPivots(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  pRolesSheetId: number;
}): Promise<ExistingPRolesPivot[]> {
  const { sheets, spreadsheetId, pRolesSheetId } = options;
  // Pivot objects live on a single anchor cell; scan near the top-left.
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: true,
    ranges: [`'${P_ROLES_SHEET_TITLE}'!A1:Z80`],
    fields:
      "sheets(properties(sheetId,title),data(rowData(values(pivotTable))))",
  });
  const sheet = (res.data.sheets ?? []).find(
    (s) => s.properties?.sheetId === pRolesSheetId
  );
  const found: ExistingPRolesPivot[] = [];
  const rows = sheet?.data?.[0]?.rowData ?? [];
  for (let r = 0; r < rows.length; r++) {
    const vals = rows[r].values ?? [];
    for (let c = 0; c < vals.length; c++) {
      const pivot = vals[c].pivotTable;
      if (pivot?.source) {
        found.push({
          pRolesSheetId,
          rowIndex: r,
          columnIndex: c,
          pivot,
        });
      }
    }
  }
  return found;
}

function pivotSourceCoversLiveRange(
  existing: sheets_v4.Schema$GridRange | undefined,
  live: MasterSheetPivotSourceRange,
  masterSheetId: number
): boolean {
  if (!existing) return false;
  if (existing.sheetId !== masterSheetId) return false;
  if ((existing.startColumnIndex ?? 0) !== live.startColumnIndex) return false;
  if (existing.endColumnIndex !== live.endColumnIndex) return false;
  if ((existing.startRowIndex ?? 0) !== live.startRowIndex) return false;
  // Unbounded rows always cover growth.
  if (existing.endRowIndex == null) return true;
  return existing.endRowIndex >= live.endRowIndex;
}

async function writePivotAtAnchor(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  pRolesSheetId: number;
  rowIndex: number;
  columnIndex: number;
  pivot: sheets_v4.Schema$PivotTable;
  guardedBatchUpdate?: (
    requests: sheets_v4.Schema$Request[]
  ) => Promise<void>;
}): Promise<void> {
  // Clear any prior userEnteredValue/pivotTable in the destination band first.
  // Writing values into pivot-rendered cells can corrupt the table (#REF!).
  const requests: sheets_v4.Schema$Request[] = [
    {
      updateCells: {
        range: {
          sheetId: options.pRolesSheetId,
          startRowIndex: options.rowIndex,
          endRowIndex: options.rowIndex + 40,
          startColumnIndex: 0,
          endColumnIndex: 16,
        },
        rows: [],
        fields: "userEnteredValue,pivotTable,note",
      },
    },
    {
      updateCells: {
        rows: [{ values: [{ pivotTable: options.pivot }] }],
        start: {
          sheetId: options.pRolesSheetId,
          rowIndex: options.rowIndex,
          columnIndex: options.columnIndex,
        },
        fields: "pivotTable",
      },
    },
  ];
  if (options.guardedBatchUpdate) {
    await options.guardedBatchUpdate(requests);
  } else {
    await options.sheets.spreadsheets.batchUpdate({
      spreadsheetId: options.spreadsheetId,
      requestBody: { requests },
    });
  }
}

async function clearPivotAnchors(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  anchors: Array<{ pRolesSheetId: number; rowIndex: number; columnIndex: number }>;
  guardedBatchUpdate?: (
    requests: sheets_v4.Schema$Request[]
  ) => Promise<void>;
}): Promise<void> {
  if (options.anchors.length === 0) return;
  const requests: sheets_v4.Schema$Request[] = options.anchors.map((a) => ({
    updateCells: {
      range: {
        sheetId: a.pRolesSheetId,
        startRowIndex: a.rowIndex,
        endRowIndex: a.rowIndex + 40,
        startColumnIndex: 0,
        endColumnIndex: 16,
      },
      rows: [],
      fields: "userEnteredValue,pivotTable,note",
    },
  }));
  if (options.guardedBatchUpdate) {
    await options.guardedBatchUpdate(requests);
  } else {
    await options.sheets.spreadsheets.batchUpdate({
      spreadsheetId: options.spreadsheetId,
      requestBody: { requests },
    });
  }
}

function sourceGuardSummary(guard: SourceGuardResult): ApplyPRolesPivotResult["sourceGuard"] {
  return {
    masterSheetUnchanged: true,
    contentSha256: guard.fingerprintAfter.contentSha256,
    lastSentinelRow1Based: guard.fingerprintAfter.lastSentinelRow1Based,
    sentinelNonEmptyCount: guard.fingerprintAfter.sentinelNonEmptyCount,
  };
}

function buildApplyResult(options: {
  spreadsheetId: string;
  spreadsheetName: string;
  webViewLink: string | null;
  masterSheetId: number;
  pRolesSheetId: number;
  mode: ApplyPRolesPivotResult["mode"];
  pivotSource: MasterSheetPivotSourceRange;
  architecture: PRolesDataSourceArchitecture;
  createdNewSpreadsheet: boolean;
  duplicatePivotsRemoved: number;
  sourceGuard: ApplyPRolesPivotResult["sourceGuard"];
}): ApplyPRolesPivotResult {
  return {
    ok: true,
    spreadsheetId: options.spreadsheetId,
    spreadsheetName: options.spreadsheetName,
    webViewLink: options.webViewLink,
    masterSheetId: options.masterSheetId,
    pRolesSheetId: options.pRolesSheetId,
    mode: options.mode,
    source: {
      sheetTitle: MASTER_SHEET_TITLE,
      startRowIndex: options.pivotSource.startRowIndex,
      startColumnIndex: options.pivotSource.startColumnIndex,
      endColumnIndex: options.pivotSource.endColumnIndex,
      endRowIndex: options.pivotSource.endRowIndex,
      note: `Dynamic source ${options.pivotSource.a1Notation} (resolution=${options.pivotSource.resolution}). Refresh after Master Sheet grows. P-Roles READ-ONLY vs Master Sheet.`,
    },
    pivot: {
      rows: [P_ROLES_FIELDS.primarySkills, P_ROLES_FIELDS.skillCategorization],
      columns: [P_ROLES_FIELDS.jobManagementLevel],
      filters: [
        P_ROLES_FIELDS.jobStatus,
        P_ROLES_FIELDS.posted,
        P_ROLES_FIELDS.marketMap,
      ],
      valueField: P_ROLES_FIELDS.jobManagementLevel,
      aggregation: "COUNTA",
      filtersDynamicFromSource: true,
    },
    architecture: options.architecture,
    createdNewSpreadsheet: options.createdNewSpreadsheet,
    duplicatePivotsRemoved: options.duplicatePivotsRemoved,
    sourceGuard: options.sourceGuard,
  };
}

/**
 * Lightweight refresh: extend/update the existing P-Roles Pivot source range
 * when Master Sheet data grows. Does not create duplicates. Does not depend on Excel.
 * Skips work when the current pivot source already covers live data.
 * READ-ONLY vs Master Sheet (fingerprint + P-Roles-only writes).
 */
export async function refreshLateralPRolesPivotTable(options?: {
  forceReconfigure?: boolean;
  applyAppearance?: boolean;
}): Promise<ApplyPRolesPivotResult> {
  const forceReconfigure = options?.forceReconfigure === true;
  const applyAppearance = options?.applyAppearance === true;
  const ensured = await ensureLateralPRolesGoogleSpreadsheet();
  const { sheets, drive } = await getAuthorizedGmailClient();
  const spreadsheetId = ensured.spreadsheetId;

  const ss = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties",
  });
  const master = findSheet(ss.data, MASTER_SHEET_TITLE);
  if (master?.properties?.sheetId == null) {
    throw new Error(`Google Sheet is missing "${MASTER_SHEET_TITLE}".`);
  }
  const masterSheetId = master.properties.sheetId;

  const fpBeforeEnsure = await captureMasterSheetFingerprint({
    sheets,
    spreadsheetId,
    masterSheetId,
  });
  const pRoles = await ensurePRolesSheet(sheets, spreadsheetId, ss.data);
  const pRolesSheetId = pRoles.sheetId;
  assertMasterSheetFingerprintsEqual(
    fpBeforeEnsure,
    await captureMasterSheetFingerprint({ sheets, spreadsheetId, masterSheetId })
  );

  const existing = await findExistingPRolesPivots({
    sheets,
    spreadsheetId,
    pRolesSheetId,
  });

  existing.sort((a, b) => {
    const score = (x: ExistingPRolesPivot) =>
      x.rowIndex === 0 && x.columnIndex === 0 ? 0 : 1;
    return score(a) - score(b) || a.rowIndex - b.rowIndex || a.columnIndex - b.columnIndex;
  });

  const pivotSource = await resolveMasterSheetPivotSourceRange({
    sheets,
    spreadsheetId,
    masterSheetId,
  });

  if (existing.length === 0) {
    return applyLateralPRolesPivotTable({ forceAppearance: true });
  }

  // Prefer canonical anchor below report-filter slicers.
  const needsRelocate =
    existing[0].rowIndex !== P_ROLES_PIVOT_ANCHOR.rowIndex ||
    existing[0].columnIndex !== P_ROLES_PIVOT_ANCHOR.columnIndex;

  const jobStatusAll = await readMasterSheetColumnDistinctValues({
    sheets,
    spreadsheetId,
    columnIndex: MASTER_COL.jobStatus,
  });
  const jobStatusVisible = jobStatusFilterSelectionFromSheetData(jobStatusAll);
  const jobStatusHidden = jobStatusAll.filter(
    (s) => !jobStatusVisible.includes(s)
  );
  const jmlOrdered = sortJobManagementLevelsByNumericPrefix(
    await readMasterSheetColumnDistinctValues({
      sheets,
      spreadsheetId,
      columnIndex: MASTER_COL.jobManagementLevel,
    })
  );

  const feedSheetId = await ensurePRolesFeedSheetExists({
    sheets,
    spreadsheetId,
    masterSheetId,
    endRowIndex: pivotSource.endRowIndex,
  });

  const feedPivotSource: MasterSheetPivotSourceRange = {
    ...pivotSource,
    sheetId: feedSheetId,
    startColumnIndex: 0,
    endColumnIndex: P_ROLES_FEED_JML_SORT_KEY_COL + 1,
    a1Notation: `'${P_ROLES_FEED_SHEET_TITLE}'!A1:N${pivotSource.lastRowNumber1Based}`,
  };

  const anchorPivot = existing.find(
    (p) =>
      p.rowIndex === P_ROLES_PIVOT_ANCHOR.rowIndex &&
      p.columnIndex === P_ROLES_PIVOT_ANCHOR.columnIndex
  )?.pivot;
  const needsNumericColumnOrder =
    (anchorPivot?.columns?.length ?? 0) < 2 ||
    anchorPivot?.columns?.[0]?.sourceColumnOffset !==
      P_ROLES_FEED_JML_SORT_KEY_COL ||
    anchorPivot?.source?.sheetId !== feedSheetId;

  const { result: mutation, guard } = await withMasterSheetReadOnlyGuard({
    sheets,
    spreadsheetId,
    masterSheetId,
    pRolesSheetId,
    allowedExtraSheetIds: [feedSheetId],
    run: async ({ guardedBatchUpdate }) => {
      let duplicatePivotsRemoved = 0;
      const pivots = [...existing];

      const extras = pivots.filter(
        (p) =>
          p.rowIndex !== P_ROLES_PIVOT_ANCHOR.rowIndex ||
          p.columnIndex !== P_ROLES_PIVOT_ANCHOR.columnIndex
      );
      if (extras.length > 0) {
        await clearPivotAnchors({
          sheets,
          spreadsheetId,
          anchors: extras,
          guardedBatchUpdate,
        });
        duplicatePivotsRemoved = extras.length;
      }

      await writePRolesFeedFormulas({
        feedSheetId,
        endRowIndex: pivotSource.endRowIndex,
        guardedBatchUpdate,
      });

      const alreadyCovers =
        !needsRelocate &&
        !needsNumericColumnOrder &&
        pivotSourceCoversLiveRange(
          anchorPivot?.source,
          feedPivotSource,
          feedSheetId
        );

      if (alreadyCovers && !forceReconfigure) {
        await ensurePRolesReportFilterSlicers({
          sheets,
          spreadsheetId,
          feedSheetId,
          pRolesSheetId,
          pivotSource: feedPivotSource,
          jobStatusHiddenValues: jobStatusHidden,
          guardedBatchUpdate,
        });
        return {
          mode: "unchanged" as const,
          anchor: { ...P_ROLES_PIVOT_ANCHOR },
          duplicatePivotsRemoved,
        };
      }

      const pivot = buildPRolesPivotTable({
        source: feedPivotSource,
        jobStatusVisibleValues: jobStatusVisible,
        jmlColumnsInNumericOrder: jmlOrdered,
      });
      assertJmlMetadataCoversSource({
        sourceLevels: jmlOrdered,
        metadataLevels: (pivot.columns ?? [])
          .flatMap((c) => c.valueMetadata ?? [])
          .map((m) => m.value?.stringValue || "")
          .filter(Boolean),
      });
      await writePivotAtAnchor({
        sheets,
        spreadsheetId,
        pRolesSheetId,
        rowIndex: P_ROLES_PIVOT_ANCHOR.rowIndex,
        columnIndex: P_ROLES_PIVOT_ANCHOR.columnIndex,
        pivot,
        guardedBatchUpdate,
      });

      await ensurePRolesReportFilterSlicers({
        sheets,
        spreadsheetId,
        feedSheetId,
        pRolesSheetId,
        pivotSource: feedPivotSource,
        jobStatusHiddenValues: jobStatusHidden,
        guardedBatchUpdate,
      });

      if (
        applyAppearance ||
        forceReconfigure ||
        needsRelocate ||
        needsNumericColumnOrder
      ) {
        await applyPRolesPivotAppearance({
          sheets,
          spreadsheetId,
          pRolesSheetId,
          guardedBatchUpdate,
        });
      }

      await hidePRolesSortKeyHeaderRow({
        sheets,
        spreadsheetId,
        pRolesSheetId,
        pivotRowIndex: P_ROLES_PIVOT_ANCHOR.rowIndex,
        guardedBatchUpdate,
      });

      return {
        mode: (forceReconfigure ||
        needsRelocate ||
        needsNumericColumnOrder
          ? "updated"
          : "refreshed") as "updated" | "refreshed",
        anchor: { ...P_ROLES_PIVOT_ANCHOR },
        duplicatePivotsRemoved,
      };
    },
  });

  const linkMeta = await drive.files.get({
    fileId: spreadsheetId,
    fields: "name,webViewLink",
    supportsAllDrives: true,
  });
  const prev = await readState();
  const now = new Date().toISOString();
  await writeState({
    version: 1,
    spreadsheetId,
    spreadsheetName: linkMeta.data.name || ensured.spreadsheetName,
    webViewLink: linkMeta.data.webViewLink ?? ensured.webViewLink,
    seededFromDriveFileId:
      prev?.seededFromDriveFileId || getLateralMasterDriveFileId(),
    pivotAnchor: mutation.anchor,
    createdAt: prev?.createdAt || now,
    updatedAt: now,
    lastPivotAppliedAt: prev?.lastPivotAppliedAt ?? now,
    lastPivotRefreshedAt: now,
  });

  const architecture = await verifyPRolesDataSourceArchitecture({
    spreadsheetId,
  });

  return buildApplyResult({
    spreadsheetId,
    spreadsheetName: linkMeta.data.name || ensured.spreadsheetName,
    webViewLink: linkMeta.data.webViewLink ?? ensured.webViewLink,
    masterSheetId,
    pRolesSheetId,
    mode: mutation.mode,
    pivotSource,
    architecture,
    createdNewSpreadsheet: false,
    duplicatePivotsRemoved: mutation.duplicatePivotsRemoved,
    sourceGuard: sourceGuardSummary(guard),
  });
}

/**
 * Create or update the single P-Roles Pivot Table (no duplicates).
 * If a pivot already exists, update it in place instead of creating another.
 * READ-ONLY vs Master Sheet — all writes are guarded to the P-Roles tab only.
 */
export async function applyLateralPRolesPivotTable(options?: {
  sourceDriveFileId?: string;
  forceNewConversion?: boolean;
  forceAppearance?: boolean;
  /** Use this existing Google Spreadsheet. Never creates a new file. */
  targetSpreadsheetId?: string;
}): Promise<ApplyPRolesPivotResult> {
  const targetId = options?.targetSpreadsheetId?.trim();
  const ensured = targetId
    ? await (async () => {
        const { drive } = await getAuthorizedGmailClient();
        const meta = await drive.files.get({
          fileId: targetId,
          fields: "id,name,mimeType,trashed,webViewLink",
          supportsAllDrives: true,
        });
        if (meta.data.trashed) {
          throw new Error(`Target spreadsheet ${targetId} is in trash.`);
        }
        if (meta.data.mimeType !== "application/vnd.google-apps.spreadsheet") {
          throw new Error(
            `Target must be a native Google Sheet. Found mimeType=${meta.data.mimeType}`
          );
        }
        const now = new Date().toISOString();
        const prev = await readState();
        await writeState({
          version: 1,
          spreadsheetId: targetId,
          spreadsheetName: meta.data.name || "Lateral Google Sheet",
          webViewLink: meta.data.webViewLink ?? null,
          seededFromDriveFileId: prev?.seededFromDriveFileId || targetId,
          pivotAnchor: prev?.pivotAnchor ?? { ...P_ROLES_PIVOT_ANCHOR },
          createdAt: prev?.createdAt || now,
          updatedAt: now,
          lastPivotAppliedAt: prev?.lastPivotAppliedAt ?? null,
          lastPivotRefreshedAt: prev?.lastPivotRefreshedAt,
        });
        return {
          spreadsheetId: targetId,
          spreadsheetName: meta.data.name || "Lateral Google Sheet",
          webViewLink: meta.data.webViewLink ?? null,
          createdNewSpreadsheet: false,
        };
      })()
    : await ensureLateralPRolesGoogleSpreadsheet(options);
  const { sheets, drive } = await getAuthorizedGmailClient();
  const spreadsheetId = ensured.spreadsheetId;

  const ss = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "spreadsheetId,properties.title,sheets.properties",
  });

  const master = findSheet(ss.data, MASTER_SHEET_TITLE);
  if (master?.properties?.sheetId == null) {
    throw new Error(
      `Google Sheet is missing "${MASTER_SHEET_TITLE}" — cannot build P-Roles pivot source.`
    );
  }
  const masterSheetId = master.properties.sheetId;

  // Validate required headers on Master Sheet row 1 (Google Sheet only — read).
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${MASTER_SHEET_TITLE}'!A1:M1`,
    majorDimension: "ROWS",
  });
  const headers = (headerRes.data.values?.[0] ?? []).map((h) =>
    String(h ?? "").trim()
  );
  const required = [
    P_ROLES_FIELDS.skillCategorization,
    P_ROLES_FIELDS.primarySkills,
    P_ROLES_FIELDS.jobManagementLevel,
    P_ROLES_FIELDS.marketMap,
    P_ROLES_FIELDS.jobStatus,
    P_ROLES_FIELDS.posted,
  ];
  for (const name of required) {
    if (!headers.includes(name)) {
      throw new Error(
        `Master Sheet is missing required header "${name}". Found: ${headers.join(", ")}`
      );
    }
  }

  const fpBeforeEnsure = await captureMasterSheetFingerprint({
    sheets,
    spreadsheetId,
    masterSheetId,
  });
  const pRoles = await ensurePRolesSheet(sheets, spreadsheetId, ss.data);
  const pRolesSheetId = pRoles.sheetId;
  assertMasterSheetFingerprintsEqual(
    fpBeforeEnsure,
    await captureMasterSheetFingerprint({ sheets, spreadsheetId, masterSheetId })
  );

  const existing = await findExistingPRolesPivots({
    sheets,
    spreadsheetId,
    pRolesSheetId,
  });
  existing.sort((a, b) => {
    const score = (x: ExistingPRolesPivot) =>
      x.rowIndex === 0 && x.columnIndex === 0 ? 0 : 1;
    return score(a) - score(b) || a.rowIndex - b.rowIndex || a.columnIndex - b.columnIndex;
  });

  const pivotSource = await resolveMasterSheetPivotSourceRange({
    sheets,
    spreadsheetId,
    masterSheetId,
  });

  const jobStatusAll = await readMasterSheetColumnDistinctValues({
    sheets,
    spreadsheetId,
    columnIndex: MASTER_COL.jobStatus,
  });
  const jobStatusVisible = jobStatusFilterSelectionFromSheetData(jobStatusAll);
  const jobStatusHidden = jobStatusAll.filter(
    (s) => !jobStatusVisible.includes(s)
  );
  const jmlOrdered = sortJobManagementLevelsByNumericPrefix(
    await readMasterSheetColumnDistinctValues({
      sheets,
      spreadsheetId,
      columnIndex: MASTER_COL.jobManagementLevel,
    })
  );

  const feedSheetId = await ensurePRolesFeedSheetExists({
    sheets,
    spreadsheetId,
    masterSheetId,
    endRowIndex: pivotSource.endRowIndex,
  });
  const feedPivotSource: MasterSheetPivotSourceRange = {
    ...pivotSource,
    sheetId: feedSheetId,
    startColumnIndex: 0,
    endColumnIndex: P_ROLES_FEED_JML_SORT_KEY_COL + 1,
    a1Notation: `'${P_ROLES_FEED_SHEET_TITLE}'!A1:N${pivotSource.lastRowNumber1Based}`,
  };
  const pivot = buildPRolesPivotTable({
    source: feedPivotSource,
    jobStatusVisibleValues: jobStatusVisible,
    jmlColumnsInNumericOrder: jmlOrdered,
  });

  const { result: mutation, guard } = await withMasterSheetReadOnlyGuard({
    sheets,
    spreadsheetId,
    masterSheetId,
    pRolesSheetId,
    allowedExtraSheetIds: [feedSheetId],
    run: async ({ guardedBatchUpdate }) => {
      let duplicatePivotsRemoved = 0;
      let mode: ApplyPRolesPivotResult["mode"] =
        existing.length > 0 ? "updated" : "created";
      const anchor = { ...P_ROLES_PIVOT_ANCHOR };

      await writePRolesFeedFormulas({
        feedSheetId,
        endRowIndex: pivotSource.endRowIndex,
        guardedBatchUpdate,
      });

      const stale = existing.filter(
        (p) =>
          p.rowIndex !== anchor.rowIndex || p.columnIndex !== anchor.columnIndex
      );
      if (stale.length > 0) {
        await clearPivotAnchors({
          sheets,
          spreadsheetId,
          anchors: stale,
          guardedBatchUpdate,
        });
        duplicatePivotsRemoved = stale.length;
      }

      await writePivotAtAnchor({
        sheets,
        spreadsheetId,
        pRolesSheetId,
        rowIndex: anchor.rowIndex,
        columnIndex: anchor.columnIndex,
        pivot,
        guardedBatchUpdate,
      });

      await ensurePRolesReportFilterSlicers({
        sheets,
        spreadsheetId,
        feedSheetId,
        pRolesSheetId,
        pivotSource: feedPivotSource,
        jobStatusHiddenValues: jobStatusHidden,
        guardedBatchUpdate,
      });

      if (mode === "created" || options?.forceAppearance === true) {
        await applyPRolesPivotAppearance({
          sheets,
          spreadsheetId,
          pRolesSheetId,
          guardedBatchUpdate,
        });
      }

      await hidePRolesSortKeyHeaderRow({
        sheets,
        spreadsheetId,
        pRolesSheetId,
        pivotRowIndex: anchor.rowIndex,
        guardedBatchUpdate,
      });

      const verify = await sheets.spreadsheets.get({
        spreadsheetId,
        fields:
          "sheets(properties(title,sheetId),data.rowData.values.pivotTable)",
        includeGridData: true,
        ranges: [
          `'${P_ROLES_SHEET_TITLE}'!${String.fromCharCode(
            65 + anchor.columnIndex
          )}${anchor.rowIndex + 1}`,
        ],
      });
      const verifySheet = findSheet(verify.data, P_ROLES_SHEET_TITLE);
      const placed =
        verifySheet?.data?.[0]?.rowData?.[0]?.values?.[0]?.pivotTable ?? null;
      if (!placed?.source) {
        throw new Error("P-Roles pivot was not found after update.");
      }
      if (placed.source.sheetId !== feedSheetId) {
        throw new Error(
          `P-Roles pivot source sheetId mismatch (expected feed ${feedSheetId}, got ${placed.source.sheetId}).`
        );
      }
      if (
        placed.source.endRowIndex != null &&
        placed.source.endRowIndex < pivotSource.endRowIndex
      ) {
        throw new Error(
          `P-Roles pivot source endRowIndex=${placed.source.endRowIndex} is shorter than resolved Master data end ${pivotSource.endRowIndex}.`
        );
      }
      if (!placed.filterSpecs || placed.filterSpecs.length < 3) {
        throw new Error(
          "P-Roles pivot is missing native filterSpecs (Job Status / Posted / Market Map)."
        );
      }
      if (
        (placed.columns?.length ?? 0) < 2 ||
        placed.columns?.[0]?.sourceColumnOffset !== P_ROLES_FEED_JML_SORT_KEY_COL
      ) {
        throw new Error(
          "P-Roles pivot is missing numeric JML sort-key column group for prefix ordering."
        );
      }

      const placedJmlMeta = (placed.columns ?? [])
        .flatMap((c) => c.valueMetadata ?? [])
        .map((m) => m.value?.stringValue || "")
        .filter(Boolean);
      assertJmlMetadataCoversSource({
        sourceLevels: jmlOrdered,
        metadataLevels: placedJmlMeta,
      });

      const after = await findExistingPRolesPivots({
        sheets,
        spreadsheetId,
        pRolesSheetId,
      });
      if (after.length > 1) {
        await clearPivotAnchors({
          sheets,
          spreadsheetId,
          anchors: after.slice(1),
          guardedBatchUpdate,
        });
        duplicatePivotsRemoved += after.length - 1;
      }

      return { mode, anchor, duplicatePivotsRemoved };
    },
  });

  const linkMeta = await drive.files.get({
    fileId: spreadsheetId,
    fields: "name,webViewLink",
    supportsAllDrives: true,
  });

  const prev = await readState();
  const now = new Date().toISOString();
  await writeState({
    version: 1,
    spreadsheetId,
    spreadsheetName: linkMeta.data.name || ensured.spreadsheetName,
    webViewLink: linkMeta.data.webViewLink ?? ensured.webViewLink,
    seededFromDriveFileId:
      prev?.seededFromDriveFileId ||
      options?.sourceDriveFileId ||
      getLateralMasterDriveFileId(),
    pivotAnchor: mutation.anchor,
    createdAt: prev?.createdAt || now,
    updatedAt: now,
    lastPivotAppliedAt: now,
    lastPivotRefreshedAt: now,
  });

  const architecture = await verifyPRolesDataSourceArchitecture({
    spreadsheetId,
  });

  return buildApplyResult({
    spreadsheetId,
    spreadsheetName: linkMeta.data.name || ensured.spreadsheetName,
    webViewLink: linkMeta.data.webViewLink ?? ensured.webViewLink,
    masterSheetId,
    pRolesSheetId,
    mode: mutation.mode,
    pivotSource,
    architecture,
    createdNewSpreadsheet: ensured.createdNewSpreadsheet,
    duplicatePivotsRemoved: mutation.duplicatePivotsRemoved,
    sourceGuard: sourceGuardSummary(guard),
  });
}
