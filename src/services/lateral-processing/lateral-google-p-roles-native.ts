/**
 * Native Google Spreadsheet P-Roles (separate from the production XLSM).
 *
 * Architecture:
 *   Drive XLSM Master Sheet (read-only download)
 *     → extract P-Roles fields
 *     → batch-write _P-Roles Feed
 *     → Google Sheets formulas on P-Roles
 *
 * Does not convert, upload, or save the production XLSM.
 * Does not write .data/lateral-p-roles-google-sheet.json (dashboard UI unchanged).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getLateralMasterDriveFileId } from "@/lib/config/runtime";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";

const execFileAsync = promisify(execFile);

export function getProductionXlsmId(): string {
  return getLateralMasterDriveFileId();
}
export const NATIVE_P_ROLES_TITLE = "ARA Dashboard — P-Roles";
export const P_ROLES_SHEET = "P-Roles";
export const FEED_SHEET = "_P-Roles Feed";
export const CONFIG_SHEET = "_Config";
export const FILTERED_SHEET = "_P-Roles Filtered";

export const JML_ORDER = [
  "8-Associate Manager",
  "9-Team Lead/Consultant",
  "10-Senior Analyst",
  "11-Analyst",
  "12-Associate",
] as const;

export const JOB_STATUSES = ["Active", "New", "Closed", "Reopen"] as const;
export const DEFAULT_STATUS_SELECTED = {
  Active: true,
  New: true,
  Reopen: true,
  Closed: false,
} as const;

export const FEED_HEADERS = [
  "Job Requisition ID",
  "Primary Skills",
  "Skill Categorization",
  "Job Management Level",
  "Job Status",
  "Posted",
  "Market Map",
] as const;

const STATE_PATH = path.join(
  process.cwd(),
  ".data",
  "lateral-native-p-roles-google-sheet.json"
);

export interface NativePRolesState {
  version: 1;
  spreadsheetId: string;
  spreadsheetName: string;
  webViewLink: string | null;
  createdAt: string;
  lastRefreshedAt: string | null;
  feedRowCount: number | null;
  masterRowCount: number | null;
}

export interface PRolesFeedExtract {
  headers: string[];
  masterHeaders: string[];
  rowCount: number;
  rows: string[][];
}

export interface RefreshGooglePRolesResult {
  ok: true;
  spreadsheetId: string;
  spreadsheetName: string;
  webViewLink: string | null;
  masterRowCount: number;
  feedRowCount: number;
  independent: {
    defaultStatus: string[];
    jmlCounts: Record<string, number>;
    grandTotal: number;
    withClosedGrandTotal: number;
    closedAvailable: true;
  };
}

async function readState(): Promise<NativePRolesState | null> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as NativePRolesState;
    if (parsed?.version === 1 && parsed.spreadsheetId) return parsed;
  } catch {
    /* missing */
  }
  return null;
}

async function writeState(next: NativePRolesState): Promise<void> {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(next, null, 2), "utf8");
}

export async function readNativeGooglePRolesState(): Promise<NativePRolesState | null> {
  return readState();
}

function requireNativePRolesState(
  state: NativePRolesState | null
): NativePRolesState {
  if (state === null) {
    throw new Error(
      "Native Google P-Roles spreadsheet is not configured. Run Step 10 create first."
    );
  }
  return state;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function independentCounts(rows: string[][], statuses: string[]) {
  const statusSet = new Set(statuses);
  const jmlCounts: Record<string, number> = {
    "8-Associate Manager": 0,
    "9-Team Lead/Consultant": 0,
    "10-Senior Analyst": 0,
    "11-Analyst": 0,
    "12-Associate": 0,
  };
  for (const row of rows) {
    const jml = row[3] || "";
    const status = row[4] || "";
    if (!statusSet.has(status)) continue;
    if (jml in jmlCounts) jmlCounts[jml] += 1;
  }
  const grandTotal = JML_ORDER.reduce((sum, name) => sum + jmlCounts[name], 0);
  return { jmlCounts, grandTotal };
}

export async function extractMasterPRolesFeed(localXlsmPath: string): Promise<PRolesFeedExtract> {
  const outPath = path.join(os.tmpdir(), `p-roles-feed-${Date.now()}.json`);
  const script = path.join(
    process.cwd(),
    "scripts",
    "_extract-master-p-roles-feed.py"
  );
  const runExtract = async (bin: string, args: string[]) =>
    execFileAsync(bin, args, {
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  let stdout = "";
  try {
    ({ stdout } = await runExtract("python", [script, localXlsmPath, outPath]));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    ({ stdout } = await runExtract("py", ["-3", script, localXlsmPath, outPath]));
  }
  const meta = JSON.parse((stdout || "").trim() || "{}") as {
    ok?: boolean;
    error?: string;
  };
  if (!meta.ok) {
    throw new Error(meta.error || "Master P-Roles extract failed");
  }
  const raw = JSON.parse(await fs.readFile(outPath, "utf8")) as PRolesFeedExtract & {
    ok?: boolean;
  };
  await fs.unlink(outPath).catch(() => undefined);
  if (!raw.rows || !Array.isArray(raw.rows)) {
    throw new Error("P-Roles extract produced no rows");
  }
  return raw;
}

async function downloadProductionXlsmReadOnly(): Promise<{
  localPath: string;
  md5: string | null | undefined;
  size: string | null | undefined;
  modifiedTime: string | null | undefined;
}> {
  const { drive } = await getAuthorizedGmailClient();
  const meta = await drive.files.get({
    fileId: getProductionXlsmId(),
    fields: "id,name,md5Checksum,size,modifiedTime,trashed,mimeType",
    supportsAllDrives: true,
  });
  if (meta.data.trashed) {
    throw new Error("Production XLSM is in trash. Refusing to untrash or modify it.");
  }
  const localPath = path.join(os.tmpdir(), `step10-master-readonly-${Date.now()}.xlsm`);
  const media = await drive.files.get(
    { fileId: getProductionXlsmId(), alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(localPath, Buffer.from(media.data as ArrayBuffer));
  return {
    localPath,
    md5: meta.data.md5Checksum,
    size: meta.data.size ?? undefined,
    modifiedTime: meta.data.modifiedTime,
  };
}

function pRolesFormulas() {
  const feed = `'${FEED_SHEET}'`;
  const filtered = `'${FILTERED_SHEET}'`;
  const p = `'${P_ROLES_SHEET}'`;
  const mask =
    `(${feed}!A2:A<>"")*` +
    `((${feed}!E2:E="Active")*${p}!$C$5+(${feed}!E2:E="New")*${p}!$C$6+` +
    `(${feed}!E2:E="Reopen")*${p}!$C$7+(${feed}!E2:E="Closed")*${p}!$C$8)*` +
    `IF(${p}!$B$10="All",TRUE,${feed}!F2:F=${p}!$B$10)*` +
    `IF(${p}!$B$11="All",TRUE,${feed}!G2:G=${p}!$B$11)`;

  const filteredSpill = `=IFERROR(FILTER(${feed}!A2:G,${mask}),{"","","","","","",""})`;
  const uniquePairs =
    `=IFERROR(UNIQUE(FILTER({${filtered}!B2:B,${filtered}!C2:C},` +
    `(${filtered}!A2:A<>"")*((${filtered}!D2:D=C$13)+(${filtered}!D2:D=D$13)+` +
    `(${filtered}!D2:D=E$13)+(${filtered}!D2:D=F$13)+(${filtered}!D2:D=G$13)))),"")`;

  const countCol = (headerCell: string) =>
    `=IFERROR(LET(n,COUNTA(A14:A),IF(n=0,0,MAP(A14:INDEX(A14:A,n),B14:INDEX(B14:B,n),LAMBDA(s,c,` +
    `COUNTIFS(${filtered}!$B:$B,s,${filtered}!$C:$C,c,${filtered}!$D:$D,${headerCell}))))),"")`;

  const grand =
    `=ARRAYFORMULA(IF(LEN(A14:A)=0,,N(C14:C)+N(D14:D)+N(E14:E)+N(F14:F)+N(G14:G)))`;
  const displayedGrand = `=IFERROR(N(C12)+N(D12)+N(E12)+N(F12)+N(G12),0)`;

  return { filteredSpill, uniquePairs, countCol, grand, displayedGrand };
}

async function ensureSheetRowCount(
  sheets: Awaited<ReturnType<typeof getAuthorizedGmailClient>>["sheets"],
  spreadsheetId: string,
  title: string,
  minRows: number
) {
  const ss = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties",
  });
  const found = ss.data.sheets?.find((s) => s.properties?.title === title);
  const sheetId = found?.properties?.sheetId;
  const current = found?.properties?.gridProperties?.rowCount ?? 0;
  if (sheetId == null) {
    throw new Error(`Sheet ${title} is missing`);
  }
  if (current >= minRows) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: { rowCount: minRows },
            },
            fields: "gridProperties.rowCount",
          },
        },
      ],
    },
  });
}

async function writeFeed(
  sheets: Awaited<ReturnType<typeof getAuthorizedGmailClient>>["sheets"],
  spreadsheetId: string,
  rows: string[][]
) {
  const needed = rows.length + 10;
  await ensureSheetRowCount(sheets, spreadsheetId, FEED_SHEET, needed);
  await ensureSheetRowCount(sheets, spreadsheetId, FILTERED_SHEET, needed);
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${FEED_SHEET}'!A:G`,
  });
  const headerAndRows: string[][] = [[...FEED_HEADERS], ...rows];
  const chunk = 5000;
  for (let i = 0; i < headerAndRows.length; i += chunk) {
    const part = headerAndRows.slice(i, i + chunk);
    const startRow = i + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${FEED_SHEET}'!A${startRow}`,
      valueInputOption: "RAW",
      requestBody: { values: part },
    });
  }
}

async function applyPRolesCalculationFormulas(
  sheets: Awaited<ReturnType<typeof getAuthorizedGmailClient>>["sheets"],
  spreadsheetId: string
) {
  const { filteredSpill, uniquePairs, countCol, grand, displayedGrand } = pRolesFormulas();
  const colSum = (col: string) => `=IFERROR(SUM(${col}14:${col}),0)`;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: `'${FILTERED_SHEET}'!A2`, values: [[filteredSpill]] },
        { range: `'${P_ROLES_SHEET}'!B3`, values: [[displayedGrand]] },
        {
          range: `'${P_ROLES_SHEET}'!C12:H12`,
          values: [[colSum("C"), colSum("D"), colSum("E"), colSum("F"), colSum("G"), colSum("H")]],
        },
        { range: `'${P_ROLES_SHEET}'!A14`, values: [[uniquePairs]] },
        {
          range: `'${P_ROLES_SHEET}'!C14:H14`,
          values: [[
            countCol("C$13"),
            countCol("D$13"),
            countCol("E$13"),
            countCol("F$13"),
            countCol("G$13"),
            grand,
          ]],
        },
      ],
    },
  });
}

/**
 * Download production XLSM (read-only), replace _P-Roles Feed, keep P-Roles layout.
 */
export async function refreshGooglePRoles(): Promise<RefreshGooglePRolesResult> {
  throw new Error(
    "Do not refresh a separate Google Spreadsheet for P-Roles. Use refreshGoogleCompatiblePRoles() on the configured production XLSM."
  );
  const state = requireNativePRolesState(await readState());

  const { drive, sheets } = await getAuthorizedGmailClient();
  const meta = await drive.files.get({
    fileId: state.spreadsheetId,
    fields: "id,name,mimeType,trashed,webViewLink",
    supportsAllDrives: true,
  });
  if (meta.data.trashed || meta.data.mimeType !== "application/vnd.google-apps.spreadsheet") {
    throw new Error("Configured native P-Roles file is missing or is not a Google Spreadsheet.");
  }

  const downloaded = await downloadProductionXlsmReadOnly();
  let extract: PRolesFeedExtract;
  try {
    extract = await extractMasterPRolesFeed(downloaded.localPath);
  } finally {
    await fs.unlink(downloaded.localPath).catch(() => undefined);
  }

  await writeFeed(sheets, state.spreadsheetId, extract.rows);
  await applyPRolesCalculationFormulas(sheets, state.spreadsheetId);

  const markets = Array.from(
    new Set(extract.rows.map((r) => r[6]).filter((v) => v && v !== "All"))
  ).sort((a, b) => a.localeCompare(b));
  await sheets.spreadsheets.values.update({
    spreadsheetId: state.spreadsheetId,
    range: `'${CONFIG_SHEET}'!G1:G${markets.length + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [["All"], ...markets.map((m) => [m])] },
  });

  const defaultStatus = ["Active", "New", "Reopen"];
  const independent = independentCounts(extract.rows, defaultStatus);
  const withClosed = independentCounts(extract.rows, [
    "Active",
    "New",
    "Reopen",
    "Closed",
  ]);

  const next: NativePRolesState = {
    version: 1,
    spreadsheetId: state.spreadsheetId,
    spreadsheetName: meta.data.name || state.spreadsheetName,
    webViewLink: meta.data.webViewLink ?? state.webViewLink,
    createdAt: state.createdAt,
    lastRefreshedAt: new Date().toISOString(),
    feedRowCount: extract.rowCount,
    masterRowCount: extract.rowCount,
  };
  await writeState(next);

  return {
    ok: true,
    spreadsheetId: state.spreadsheetId,
    spreadsheetName: next.spreadsheetName,
    webViewLink: next.webViewLink,
    masterRowCount: extract.rowCount,
    feedRowCount: extract.rowCount,
    independent: {
      defaultStatus,
      jmlCounts: independent.jmlCounts,
      grandTotal: independent.grandTotal,
      withClosedGrandTotal: withClosed.grandTotal,
      closedAvailable: true,
    },
  };
}

export async function createNativeGooglePRolesSpreadsheet(): Promise<{
  spreadsheetId: string;
  spreadsheetName: string;
  webViewLink: string | null;
  created: true;
}> {
  throw new Error(
    "Do not create a separate Google Spreadsheet for P-Roles. Use the P-Roles tab inside the configured production XLSM via refreshGoogleCompatiblePRoles()."
  );
  const existingOrNull = await readState();
  if (existingOrNull !== null) {
    const existing = requireNativePRolesState(existingOrNull);
    const { drive } = await getAuthorizedGmailClient();
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
          created: true,
        };
      }
    } catch {
      /* create new */
    }
  }

  const { drive, sheets } = await getAuthorizedGmailClient();
  let created;
  try {
    created = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: NATIVE_P_ROLES_TITLE },
        sheets: [
          { properties: { title: P_ROLES_SHEET, index: 0 } },
          {
            properties: {
              title: FEED_SHEET,
              index: 1,
              gridProperties: { rowCount: 25000, columnCount: 7 },
            },
          },
          { properties: { title: CONFIG_SHEET, index: 2 } },
          {
            properties: {
              title: FILTERED_SHEET,
              index: 3,
              hidden: true,
              gridProperties: { rowCount: 25000, columnCount: 7 },
            },
          },
        ],
      },
      fields: "spreadsheetId,spreadsheetUrl,properties,sheets.properties",
    });
  } catch (err: unknown) {
    throw new Error(
      `Could not create a native Google Spreadsheet. Check OAuth scopes include spreadsheets + Drive. ${errorMessage(err)}`
    );
  }

  const spreadsheetId = created.data.spreadsheetId;
  if (!spreadsheetId) {
    throw new Error("Google Sheets create returned no spreadsheetId.");
  }

  try {
    const xlsm = await drive.files.get({
      fileId: getProductionXlsmId(),
      fields: "parents",
      supportsAllDrives: true,
    });
    const parent = xlsm.data.parents?.[0];
    if (parent) {
      const current = await drive.files.get({
        fileId: spreadsheetId,
        fields: "parents",
        supportsAllDrives: true,
      });
      await drive.files.update({
        fileId: spreadsheetId,
        addParents: parent,
        removeParents: (current.data.parents || []).join(","),
        supportsAllDrives: true,
        fields: "id,parents",
      });
    }
  } catch {
    /* stay in Drive root */
  }

  const ss = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "spreadsheetId,spreadsheetUrl,properties,sheets.properties",
  });
  const sheetId = (title: string) => {
    const found = ss.data.sheets?.find((s) => s.properties?.title === title);
    const id = found?.properties?.sheetId;
    if (id == null) throw new Error(`Sheet ${title} missing after create`);
    return id;
  };
  const pRolesId = sheetId(P_ROLES_SHEET);
  const filteredId = sheetId(FILTERED_SHEET);
  const { filteredSpill, uniquePairs, countCol, grand, displayedGrand } = pRolesFormulas();
  const selectedStatuses =
    '=IFERROR(TEXTJOIN(", ",TRUE,IF($C$5,A5,""),IF($C$6,A6,""),IF($C$7,A7,""),IF($C$8,A8,"")),"")';
  const colSum = (col: string) => `=IFERROR(SUM(${col}14:${col}),0)`;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: `'${CONFIG_SHEET}'!A1:E6`,
          values: [
            ["Job Status", "", "Posted", "", "JML order"],
            ["Active", "", "-", "", JML_ORDER[0]],
            ["New", "", "Yes", "", JML_ORDER[1]],
            ["Closed", "", "", "", JML_ORDER[2]],
            ["Reopen", "", "", "", JML_ORDER[3]],
            ["", "", "", "", JML_ORDER[4]],
          ],
        },
        {
          range: `'${CONFIG_SHEET}'!G1`,
          values: [["All"]],
        },
        {
          range: `'${FILTERED_SHEET}'!A1:G1`,
          values: [[...FEED_HEADERS]],
        },
        {
          range: `'${FILTERED_SHEET}'!A2`,
          values: [[filteredSpill]],
        },
        {
          range: `'${P_ROLES_SHEET}'!A1:H13`,
          values: [
            ["P-Roles", "", "", "", "", "", "", ""],
            [
              "Value = Count of Job Requisition ID. Source = production Master Sheet (read-only).",
              "",
              "",
              "",
              "",
              "",
              "",
              "",
            ],
            ["Displayed Grand Total", displayedGrand, "", "", "", "", "", ""],
            ["Job Status", selectedStatuses, "", "", "", "", "", ""],
            ["Active", "", "TRUE", "", "", "", "", ""],
            ["New", "", "TRUE", "", "", "", "", ""],
            ["Reopen", "", "TRUE", "", "", "", "", ""],
            ["Closed", "", "FALSE", "", "", "", "", ""],
            ["", "", "", "", "", "", "", ""],
            ["Posted", "All", "", "", "", "", "", ""],
            ["Market Map", "All", "", "", "", "", "", ""],
            [
              "Column totals",
              "",
              colSum("C"),
              colSum("D"),
              colSum("E"),
              colSum("F"),
              colSum("G"),
              colSum("H"),
            ],
            [
              "Primary Skills",
              "Skill Categorization",
              `=${CONFIG_SHEET}!E2`,
              `=${CONFIG_SHEET}!E3`,
              `=${CONFIG_SHEET}!E4`,
              `=${CONFIG_SHEET}!E5`,
              `=${CONFIG_SHEET}!E6`,
              "Grand Total",
            ],
          ],
        },
        {
          range: `'${P_ROLES_SHEET}'!A14`,
          values: [[uniquePairs]],
        },
        {
          range: `'${P_ROLES_SHEET}'!C14:H14`,
          values: [
            [
              countCol("C$13"),
              countCol("D$13"),
              countCol("E$13"),
              countCol("F$13"),
              countCol("G$13"),
              grand,
            ],
          ],
        },
      ],
    },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: pRolesId,
              startRowIndex: 4,
              endRowIndex: 8,
              startColumnIndex: 2,
              endColumnIndex: 3,
            },
            cell: {
              dataValidation: {
                condition: { type: "BOOLEAN" },
                showCustomUi: true,
                strict: true,
              },
            },
            fields: "dataValidation",
          },
        },
        {
          setDataValidation: {
            range: {
              sheetId: pRolesId,
              startRowIndex: 9,
              endRowIndex: 10,
              startColumnIndex: 1,
              endColumnIndex: 2,
            },
            rule: {
              condition: {
                type: "ONE_OF_LIST",
                values: [
                  { userEnteredValue: "All" },
                  { userEnteredValue: "-" },
                  { userEnteredValue: "Yes" },
                ],
              },
              showCustomUi: true,
              strict: true,
            },
          },
        },
        {
          setDataValidation: {
            range: {
              sheetId: pRolesId,
              startRowIndex: 10,
              endRowIndex: 11,
              startColumnIndex: 1,
              endColumnIndex: 2,
            },
            rule: {
              condition: {
                type: "ONE_OF_RANGE",
                values: [{ userEnteredValue: `='${CONFIG_SHEET}'!$G$1:$G$500` }],
              },
              showCustomUi: true,
              strict: false,
            },
          },
        },
        {
          repeatCell: {
            range: {
              sheetId: pRolesId,
              startRowIndex: 12,
              endRowIndex: 13,
              startColumnIndex: 0,
              endColumnIndex: 8,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.12, green: 0.31, blue: 0.47 },
                textFormat: {
                  bold: true,
                  foregroundColor: { red: 1, green: 1, blue: 1 },
                },
                horizontalAlignment: "CENTER",
                wrapStrategy: "WRAP",
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,wrapStrategy)",
          },
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId: pRolesId,
              dimension: "COLUMNS",
              startIndex: 0,
              endIndex: 1,
            },
            properties: { pixelSize: 220 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId: pRolesId,
              dimension: "COLUMNS",
              startIndex: 1,
              endIndex: 2,
            },
            properties: { pixelSize: 200 },
            fields: "pixelSize",
          },
        },
        {
          updateSheetProperties: {
            properties: {
              sheetId: pRolesId,
              gridProperties: { frozenRowCount: 13 },
            },
            fields: "gridProperties.frozenRowCount",
          },
        },
        {
          mergeCells: {
            range: {
              sheetId: pRolesId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: 8,
            },
            mergeType: "MERGE_ALL",
          },
        },
        {
          repeatCell: {
            range: {
              sheetId: pRolesId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: 8,
            },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true, fontSize: 18 },
                verticalAlignment: "MIDDLE",
              },
            },
            fields: "userEnteredFormat(textFormat,verticalAlignment)",
          },
        },
        {
          repeatCell: {
            range: {
              sheetId: pRolesId,
              startRowIndex: 11,
              endRowIndex: 12,
              startColumnIndex: 0,
              endColumnIndex: 8,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 },
                textFormat: { bold: true },
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat)",
          },
        },
        {
          repeatCell: {
            range: {
              sheetId: pRolesId,
              startRowIndex: 11,
              endRowIndex: 5000,
              startColumnIndex: 2,
              endColumnIndex: 8,
            },
            cell: {
              userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "0" } },
            },
            fields: "userEnteredFormat.numberFormat",
          },
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId: pRolesId,
              dimension: "COLUMNS",
              startIndex: 2,
              endIndex: 8,
            },
            properties: { pixelSize: 130 },
            fields: "pixelSize",
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId: filteredId, hidden: true },
            fields: "hidden",
          },
        },
      ],
    },
  });

  const linkMeta = await drive.files.get({
    fileId: spreadsheetId,
    fields: "id,name,webViewLink,mimeType",
    supportsAllDrives: true,
  });

  await writeState({
    version: 1,
    spreadsheetId,
    spreadsheetName: linkMeta.data.name || NATIVE_P_ROLES_TITLE,
    webViewLink: linkMeta.data.webViewLink ?? created.data.spreadsheetUrl ?? null,
    createdAt: new Date().toISOString(),
    lastRefreshedAt: null,
    feedRowCount: null,
    masterRowCount: null,
  });

  return {
    spreadsheetId,
    spreadsheetName: linkMeta.data.name || NATIVE_P_ROLES_TITLE,
    webViewLink: linkMeta.data.webViewLink ?? created.data.spreadsheetUrl ?? null,
    created: true,
  };
}
