import "server-only";

import type { sheets_v4 } from "googleapis";
import {
  EXECUTIVE_NEW_SHEET_NAME,
  buildExecutiveImportPlan,
  mapBaseDsRowsToNewSheet,
  type ExecutiveCellValue,
} from "@/services/dataset/executive-dataset-mapping";

export interface ExecutiveNewSheetWriteResult {
  spreadsheetId: string;
  sheetName: string;
  sheetId: number;
  headerRow: string[];
  rowsWritten: number;
  cleared: boolean;
  verified: boolean;
  verification: {
    destinationRowCount: number;
    headerUnchanged: boolean;
    firstMappedOk: boolean;
    lastMappedOk: boolean;
    noOldRowsRemain: boolean;
  };
  unmappedDestinationHeaders: string[];
  clearedBeforeWrite: boolean;
  partialWrite: boolean;
}

function colLetter(index0: number): string {
  let n = index0 + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function a1Range(
  sheetName: string,
  startRow1: number,
  startCol0: number,
  endRow1: number,
  endCol0: number
) {
  const start = `${colLetter(startCol0)}${startRow1}`;
  const end = `${colLetter(endCol0)}${endRow1}`;
  return `'${sheetName.replace(/'/g, "''")}'!${start}:${end}`;
}

async function resolveNewSheetId(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string
): Promise<{ sheetId: number; title: string }> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });
  const match = (meta.data.sheets ?? []).find(
    (sheet) =>
      (sheet.properties?.title ?? "").trim().toLowerCase() ===
      EXECUTIVE_NEW_SHEET_NAME.toLowerCase()
  );
  const sheetId = match?.properties?.sheetId;
  const title = match?.properties?.title;
  if (sheetId === undefined || sheetId === null || !title) {
    throw new Error(
      `Destination worksheet "${EXECUTIVE_NEW_SHEET_NAME}" was not found in the configured spreadsheet.`
    );
  }
  return { sheetId, title };
}

async function readHeaderRow(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetTitle: string
): Promise<string[]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetTitle.replace(/'/g, "''")}'!1:1`,
    majorDimension: "ROWS",
  });
  const row = (res.data.values?.[0] ?? []).map((cell) =>
    cell === null || cell === undefined ? "" : String(cell)
  );
  // Trim trailing empties but keep internal blanks
  while (row.length > 0 && !String(row[row.length - 1] ?? "").trim()) {
    row.pop();
  }
  if (row.length === 0) {
    throw new Error("New Sheet header row is empty.");
  }
  return row;
}

function headersEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (value, index) =>
      value.replace(/\u00a0/g, " ").trim() ===
      String(b[index] ?? "")
        .replace(/\u00a0/g, " ")
        .trim()
  );
}

function sampleMappedOk(
  sourceHeaders: string[],
  sourceRow: ExecutiveCellValue[],
  destHeaders: string[],
  destRow: unknown[],
  plan: ReturnType<typeof buildExecutiveImportPlan>
): boolean {
  const { outputRows } = mapBaseDsRowsToNewSheet(
    sourceHeaders,
    [sourceRow],
    plan
  );
  const expected = outputRows[0] ?? [];
  for (let i = 0; i < destHeaders.length; i += 1) {
    const exp = expected[i];
    const got = destRow[i];
    const expText =
      exp === null || exp === undefined ? "" : String(exp).trim();
    const gotText =
      got === null || got === undefined ? "" : String(got).trim();
    if (expText !== gotText) {
      // Numbers may come back as strings from Sheets
      if (String(exp) === String(got)) continue;
      if (Number(expText) === Number(gotText) && expText !== "" && gotText !== "") {
        continue;
      }
      return false;
    }
  }
  return true;
}

/**
 * Clear New Sheet data (keep header) and write mapped Base DS rows.
 * Caller must have already validated source + built output in memory.
 */
export async function replaceExecutiveNewSheetData(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  sourceHeaders: string[];
  sourceRows: ExecutiveCellValue[][];
}): Promise<ExecutiveNewSheetWriteResult> {
  const { sheets, spreadsheetId, sourceHeaders, sourceRows } = options;
  const { sheetId, title } = await resolveNewSheetId(sheets, spreadsheetId);
  const headerRow = await readHeaderRow(sheets, spreadsheetId, title);
  const plan = buildExecutiveImportPlan(headerRow);
  const { outputRows } = mapBaseDsRowsToNewSheet(
    sourceHeaders,
    sourceRows,
    plan
  );

  if (outputRows.length !== sourceRows.length) {
    throw new Error(
      `Mapped row count (${outputRows.length}) does not match Base DS row count (${sourceRows.length}).`
    );
  }

  let clearedBeforeWrite = false;
  let partialWrite = false;

  // Clear all values below the header row (preserve header).
  // Using values.clear on A2:ZZ keeps formatting/structure; header untouched.
  const clearRange = `'${title.replace(/'/g, "''")}'!A2:ZZ`;
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: clearRange,
  });
  clearedBeforeWrite = true;

  try {
    if (outputRows.length > 0) {
      const endCol = Math.max(plan.destinationHeaders.length - 1, 0);
      const endRow = outputRows.length + 1; // header is row 1
      const writeRange = a1Range(title, 2, 0, endRow, endCol);
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: writeRange,
        valueInputOption: "RAW",
        requestBody: {
          majorDimension: "ROWS",
          values: outputRows,
        },
      });
    }
  } catch (error) {
    partialWrite = true;
    throw new Error(
      `Executive dataset update did not complete after New Sheet was cleared. ${
        error instanceof Error ? error.message : "Write failed."
      }`
    );
  }

  // Verify
  const verifyRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${title.replace(/'/g, "''")}'!A1:ZZ`,
    majorDimension: "ROWS",
  });
  const allRows = verifyRes.data.values ?? [];
  const headerAfter = (allRows[0] ?? []).map((cell) =>
    cell === null || cell === undefined ? "" : String(cell)
  );
  while (
    headerAfter.length > 0 &&
    !String(headerAfter[headerAfter.length - 1] ?? "").trim()
  ) {
    headerAfter.pop();
  }

  const dataAfter = allRows.slice(1).filter((row) =>
    row.some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== "")
  );

  const headerUnchanged = headersEqual(
    headerRow.map((h) => h.trim()),
    headerAfter.map((h) => h.trim()).slice(0, headerRow.length)
  );

  const firstMappedOk =
    sourceRows.length === 0 || dataAfter.length === 0
      ? sourceRows.length === 0 && dataAfter.length === 0
      : sampleMappedOk(
          sourceHeaders,
          sourceRows[0],
          plan.destinationHeaders,
          dataAfter[0] ?? [],
          plan
        );

  const lastMappedOk =
    sourceRows.length === 0 || dataAfter.length === 0
      ? sourceRows.length === 0 && dataAfter.length === 0
      : sampleMappedOk(
          sourceHeaders,
          sourceRows[sourceRows.length - 1],
          plan.destinationHeaders,
          dataAfter[dataAfter.length - 1] ?? [],
          plan
        );

  const destinationRowCount = dataAfter.length;
  const noOldRowsRemain = destinationRowCount === sourceRows.length;
  const verified =
    headerUnchanged &&
    noOldRowsRemain &&
    firstMappedOk &&
    lastMappedOk &&
    !partialWrite;

  if (!verified) {
    partialWrite = partialWrite || destinationRowCount !== sourceRows.length;
    throw new Error(
      `Executive dataset write verification failed (rows written=${destinationRowCount}, expected=${sourceRows.length}, headerUnchanged=${headerUnchanged}).`
    );
  }

  return {
    spreadsheetId,
    sheetName: title,
    sheetId,
    headerRow,
    rowsWritten: outputRows.length,
    cleared: clearedBeforeWrite,
    verified,
    verification: {
      destinationRowCount,
      headerUnchanged,
      firstMappedOk,
      lastMappedOk,
      noOldRowsRemain,
    },
    unmappedDestinationHeaders: plan.unmappedDestinationHeaders,
    clearedBeforeWrite,
    partialWrite,
  };
}

/** Validate destination headers without clearing/writing. */
export async function previewExecutiveNewSheetHeaders(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
}): Promise<{
  sheetName: string;
  headers: string[];
  plan: ReturnType<typeof buildExecutiveImportPlan>;
}> {
  const { sheetId: _sheetId, title } = await resolveNewSheetId(
    options.sheets,
    options.spreadsheetId
  );
  void _sheetId;
  const headers = await readHeaderRow(
    options.sheets,
    options.spreadsheetId,
    title
  );
  const plan = buildExecutiveImportPlan(headers);
  return { sheetName: title, headers, plan };
}
