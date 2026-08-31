/**
 * Stage 29A: Drive workbook/worksheet discovery for Lateral processing setup wizard.
 * Matches Next src/services/lateral-processing/setup-validation.ts (GET paths only).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import { getAuthorizedGmailClient } from "../gmail-oauth-read.js";
import type { WorkbookOption } from "../../types/lateral-processing-setup.js";

const execFileAsync = promisify(execFile);

const EXCEL_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
  "application/vnd.ms-excel",
]);

const GOOGLE_SHEETS_MIME = "application/vnd.google-apps.spreadsheet";

function isMasterCandidateMime(mime: string, name: string): boolean {
  return (
    EXCEL_MIME_TYPES.has(mime) ||
    mime === GOOGLE_SHEETS_MIME ||
    /\.(xlsx|xlsm|xls)$/i.test(name)
  );
}

async function listWorksheetNamesWithPython(filePath: string): Promise<string[]> {
  const script = [
    "from openpyxl import load_workbook",
    "import json,sys",
    "wb = load_workbook(sys.argv[1], read_only=True, keep_vba=True, data_only=True)",
    "print(json.dumps(wb.sheetnames))",
    "wb.close()",
  ].join(";");

  const result = await execFileAsync("python", ["-c", script, filePath], {
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const text = (result.stdout || "").trim();
  return JSON.parse(text) as string[];
}

async function listWorksheetNames(filePath: string): Promise<string[]> {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".xlsx")) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    return workbook.worksheets.map((sheet) => sheet.name);
  }
  return listWorksheetNamesWithPython(filePath);
}

async function downloadDriveFileToTemp(
  fileId: string,
  nameHint: string
): Promise<string> {
  const { drive } = await getAuthorizedGmailClient();
  const safeName = (nameHint || fileId).replace(/[^\w.-]+/g, "_");
  const tempPath = path.join(
    os.tmpdir(),
    `lateral-setup-${Date.now()}-${safeName}`
  );
  const response = await drive.files.get(
    {
      fileId,
      alt: "media",
      supportsAllDrives: true,
    },
    { responseType: "arraybuffer" }
  );
  const bytes = Buffer.from(response.data as ArrayBuffer);
  await fs.writeFile(tempPath, bytes);
  return tempPath;
}

export async function listExcelWorkbooksInFolder(
  folderId: string
): Promise<WorkbookOption[]> {
  const { drive } = await getAuthorizedGmailClient();
  const rows: WorkbookOption[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken, files(id,name,mimeType,modifiedTime,webViewLink)",
      pageToken,
      pageSize: 200,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: "allDrives",
    });
    for (const file of res.data.files ?? []) {
      const name = file.name ?? "";
      const mime = file.mimeType ?? "";
      if (isMasterCandidateMime(mime, name)) {
        rows.push({
          id: file.id ?? "",
          name,
          mimeType: mime,
          modifiedTime: file.modifiedTime ?? null,
          webViewLink: file.webViewLink ?? null,
        });
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return rows.sort((a, b) =>
    (b.modifiedTime || "").localeCompare(a.modifiedTime || "")
  );
}

export async function listDriveExcelWorkbooksByName(
  query: string
): Promise<WorkbookOption[]> {
  const { drive } = await getAuthorizedGmailClient();
  const q = query.trim().replace(/'/g, "\\'");
  if (!q) return [];

  const listOnce = async (corpora: "user" | "allDrives") => {
    const res = await drive.files.list({
      q: `trashed=false and name contains '${q}'`,
      fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
      pageSize: 50,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora,
    });
    return res.data.files ?? [];
  };

  let files = await listOnce("user");
  if (files.length === 0) {
    files = await listOnce("allDrives");
  }

  if (files.length === 0 && q.length > 24) {
    const shorter = q
      .replace(/^copy\s+of\s+/i, "")
      .split(/\s+/)
      .slice(0, 5)
      .join(" ")
      .replace(/'/g, "\\'");
    if (shorter && shorter.toLowerCase() !== q.toLowerCase()) {
      const res = await drive.files.list({
        q: `trashed=false and name contains '${shorter}'`,
        fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
        pageSize: 50,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        corpora: "user",
      });
      files = res.data.files ?? [];
    }
  }

  const byId = new Map<string, (typeof files)[number]>();
  for (const file of files) {
    if (file.id) byId.set(file.id, file);
  }

  return [...byId.values()]
    .filter((file) =>
      isMasterCandidateMime(file.mimeType ?? "", file.name ?? "")
    )
    .map((file) => ({
      id: file.id ?? "",
      name: file.name ?? "",
      mimeType: file.mimeType ?? "",
      modifiedTime: file.modifiedTime ?? null,
      webViewLink: file.webViewLink ?? null,
    }));
}

export async function listWorkbookWorksheets(
  fileId: string,
  fileName: string
): Promise<string[]> {
  const { drive, sheets } = await getAuthorizedGmailClient();
  const meta = await drive.files.get({
    fileId,
    fields: "id,name,mimeType",
    supportsAllDrives: true,
  });
  if (meta.data.mimeType === GOOGLE_SHEETS_MIME) {
    const ss = await sheets.spreadsheets.get({
      spreadsheetId: fileId,
      fields: "sheets.properties.title",
    });
    return (ss.data.sheets ?? [])
      .map((s) => s.properties?.title || "")
      .filter(Boolean);
  }

  const tempPath = await downloadDriveFileToTemp(
    fileId,
    fileName || meta.data.name || "workbook.xlsx"
  );
  try {
    return await listWorksheetNames(tempPath);
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
}
