/**
 * Read Lateral Master Sheet tab from a native Google Spreadsheet (Company UI primary source).
 */
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import type { ExcelCellValue, ExcelDataRow, ExcelReadResult } from "@/types/excel";

function cellToValue(raw: unknown): ExcelCellValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw;
  const s = String(raw).replace(/\u00a0/g, " ").trim();
  if (!s) return null;
  const asNum = Number(s.replace(/,/g, ""));
  if (s !== "" && Number.isFinite(asNum) && /^-?\d[\d,]*(\.\d+)?$/.test(s)) {
    return asNum;
  }
  return s;
}

export async function readLateralMasterSheetFromGoogleSpreadsheet(options: {
  spreadsheetId: string;
  sheetName: string;
  headerRow?: number;
  sourceLabel?: string;
}): Promise<ExcelReadResult> {
  const { sheets, drive } = await getAuthorizedGmailClient();
  const spreadsheetId = options.spreadsheetId.trim();
  const sheetName = options.sheetName.trim() || "Master Sheet";
  const headerRow1Based = Math.max(1, options.headerRow ?? 1);

  const meta = await drive.files.get({
    fileId: spreadsheetId,
    fields: "id,name,mimeType,modifiedTime",
    supportsAllDrives: true,
  });
  if (meta.data.mimeType !== "application/vnd.google-apps.spreadsheet") {
    throw new Error(
      `Primary Lateral Master must be a Google Sheet. Found mimeType=${meta.data.mimeType}`
    );
  }

  const title = meta.data.name || spreadsheetId;
  const range = `'${sheetName.replace(/'/g, "''")}'!A:Z`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    majorDimension: "ROWS",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });

  const values = res.data.values ?? [];
  const headerIdx = headerRow1Based - 1;
  if (values.length <= headerIdx) {
    throw new Error(
      `Google Sheet "${title}" tab "${sheetName}" has no header row ${headerRow1Based}.`
    );
  }

  const headers = (values[headerIdx] ?? []).map((h) =>
    String(h ?? "")
      .replace(/\u00a0/g, " ")
      .trim()
  );
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  if (headers.length === 0 || headers.every((h) => !h)) {
    throw new Error(
      `Google Sheet "${title}" tab "${sheetName}" header row is empty.`
    );
  }

  const rows: ExcelDataRow[] = [];
  for (let r = headerIdx + 1; r < values.length; r++) {
    const line = values[r] ?? [];
    const obj: ExcelDataRow = { id: `gs-${r + 1}` };
    let any = false;
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      const v = cellToValue(line[c]);
      obj[key] = v;
      if (v !== null && v !== "") any = true;
    }
    if (any) rows.push(obj);
  }

  return {
    businessUnitId: "lateral",
    sheetName,
    sourceFile: title,
    sourceLabel:
      options.sourceLabel ||
      `Google Sheet · ${title} · ${sheetName}`,
    headers,
    rows,
    meta: {
      name: sheetName,
      rowCount: rows.length,
      columnCount: headers.length,
      headerRow: headerRow1Based,
      filePath: `gdrive://${spreadsheetId}`,
      mtimeMs: meta.data.modifiedTime
        ? Date.parse(meta.data.modifiedTime)
        : undefined,
      totalRows: rows.length,
    },
  };
}
