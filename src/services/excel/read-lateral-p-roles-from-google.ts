/**
 * Resolve + read the live Google Sheet P-Roles tab for the Lateral dashboard.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import { readLateralDataProcessingSetup } from "@/services/lateral-processing/setup-store";
import { GOOGLE_SHEETS_MIME_TYPE } from "@/types/lateral-processing-setup";
import type { ExcelCellValue, ExcelDataRow, ExcelReadResult } from "@/types/excel";

const P_ROLES_STATE_PATH = path.join(
  process.cwd(),
  ".data",
  "lateral-p-roles-google-sheet.json"
);

export const LATERAL_P_ROLES_SHEET_TITLE = "P-Roles";

function cellToValue(raw: unknown): ExcelCellValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw;
  const s = String(raw).replace(/\u00a0/g, " ").trim();
  if (!s) return null;
  const asNum = Number(s.replace(/,/g, ""));
  if (Number.isFinite(asNum) && /^-?\d[\d,]*(\.\d+)?$/.test(s)) {
    return asNum;
  }
  return s;
}

export async function resolveLateralPRolesGoogleSpreadsheetId(): Promise<string | null> {
  try {
    const raw = await fs.readFile(P_ROLES_STATE_PATH, "utf8");
    const state = JSON.parse(raw) as { spreadsheetId?: string };
    if (state.spreadsheetId?.trim()) return state.spreadsheetId.trim();
  } catch {
    // fall through
  }

  try {
    const setup = await readLateralDataProcessingSetup();
    const fileId = setup?.masterWorkbook?.fileId?.trim();
    if (!fileId) return null;
    const { drive } = await getAuthorizedGmailClient();
    const meta = await drive.files.get({
      fileId,
      fields: "id,mimeType,trashed",
      supportsAllDrives: true,
    });
    if (
      !meta.data.trashed &&
      meta.data.mimeType === GOOGLE_SHEETS_MIME_TYPE
    ) {
      return fileId;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Build dashboard headers from Google P-Roles layout:
 * - Label row contains "Primary Skills"
 * - Row above may hold "Grand Total" (sort-key header row)
 */
export function buildPRolesDashboardHeaders(grid: string[][]): {
  headerRowIndex: number;
  headers: string[];
} {
  let headerRowIndex = -1;
  for (let i = 0; i < Math.min(grid.length, 20); i++) {
    const row = grid[i] || [];
    if (
      row.some((c) => /^primary\s*skills$/i.test(String(c ?? "").trim()))
    ) {
      headerRowIndex = i;
      break;
    }
  }
  if (headerRowIndex < 0) {
    throw new Error(
      'Google Sheet P-Roles is missing a "Primary Skills" header row.'
    );
  }

  const labelRow = grid[headerRowIndex] || [];
  const sortKeyRow =
    headerRowIndex > 0 ? grid[headerRowIndex - 1] || [] : [];
  const maxCol = Math.max(labelRow.length, sortKeyRow.length, 8);
  const headers: string[] = [];

  for (let c = 0; c < maxCol; c++) {
    const label = String(labelRow[c] ?? "").trim();
    const above = String(sortKeyRow[c] ?? "").trim();
    if (label) {
      headers[c] = label;
    } else if (/^grand\s*total$/i.test(above)) {
      headers[c] = "Grand Total";
    } else {
      headers[c] = "";
    }
  }

  // Drop trailing empty headers only.
  while (headers.length > 0 && !headers[headers.length - 1]) {
    headers.pop();
  }

  if (!headers.some((h) => /^primary\s*skills$/i.test(h))) {
    throw new Error("P-Roles header parse failed — Primary Skills missing.");
  }

  return { headerRowIndex, headers };
}

export async function readLateralPRolesFromGoogleSpreadsheet(options?: {
  spreadsheetId?: string;
  bypassCache?: boolean;
}): Promise<ExcelReadResult> {
  const spreadsheetId =
    options?.spreadsheetId?.trim() ||
    (await resolveLateralPRolesGoogleSpreadsheetId());
  if (!spreadsheetId) {
    throw new Error(
      "Lateral P-Roles Google Sheet is not configured (.data/lateral-p-roles-google-sheet.json)."
    );
  }

  const { sheets, drive } = await getAuthorizedGmailClient();
  const meta = await drive.files.get({
    fileId: spreadsheetId,
    fields: "id,name,mimeType,modifiedTime,trashed",
    supportsAllDrives: true,
  });
  if (meta.data.trashed) {
    throw new Error("Lateral P-Roles Google Sheet is in trash.");
  }
  if (meta.data.mimeType !== GOOGLE_SHEETS_MIME_TYPE) {
    throw new Error(
      `Lateral P-Roles host must be a Google Sheet. Found ${meta.data.mimeType}`
    );
  }

  const title =
    meta.data.name ||
    "ATCI Lateral DS AI MasterSheet Final 2026 (Google Sheet — P-Roles)";

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${LATERAL_P_ROLES_SHEET_TITLE}'!A1:Z`,
    majorDimension: "ROWS",
    valueRenderOption: "FORMATTED_VALUE",
  });
  const grid = (res.data.values ?? []).map((row) =>
    (row ?? []).map((c) => String(c ?? ""))
  );

  const { headerRowIndex, headers } = buildPRolesDashboardHeaders(grid);
  const rows: ExcelDataRow[] = [];

  for (let r = headerRowIndex + 1; r < grid.length; r++) {
    const line = grid[r] || [];
    const obj: ExcelDataRow = { id: `p-roles-${r + 1}` };
    let any = false;
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      const v = cellToValue(line[c]);
      obj[key] = v;
      if (v !== null && v !== "") any = true;
    }
    // Skip blank / fully empty rows
    if (!any) continue;
    // Skip the bottom Grand Total label row from becoming a "skill" row in the table
    // (home widgets sum Grand Total column separately).
    const skill = String(obj["Primary Skills"] ?? "").trim();
    if (/^grand\s*total$/i.test(skill)) {
      // Keep it — dashboard often needs the totals row; home widgets handle it.
      // Actually openings table shouldn't treat Grand Total as a skill opening.
      // Exclude from openings rows.
      continue;
    }
    rows.push(obj);
  }

  return {
    businessUnitId: "lateral",
    sheetName: LATERAL_P_ROLES_SHEET_TITLE,
    sourceFile: title,
    sourceLabel: `Google Sheet · ${title} · ${LATERAL_P_ROLES_SHEET_TITLE}`,
    headers: headers.filter(Boolean),
    rows: rows.map((row) => {
      // Drop empty-header keys if any slipped in
      const clean: ExcelDataRow = { id: row.id };
      for (const h of headers) {
        if (!h) continue;
        clean[h] = row[h] ?? null;
      }
      return clean;
    }),
    meta: {
      name: LATERAL_P_ROLES_SHEET_TITLE,
      rowCount: rows.length,
      columnCount: headers.filter(Boolean).length,
      headerRow: headerRowIndex + 1,
      filePath: `gdrive://${spreadsheetId}`,
      mtimeMs: meta.data.modifiedTime
        ? Date.parse(meta.data.modifiedTime)
        : undefined,
      totalRows: rows.length,
    },
  };
}
