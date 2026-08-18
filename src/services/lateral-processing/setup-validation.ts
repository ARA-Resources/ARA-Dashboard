import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import { parseDriveFolderIdFromUrl } from "@/services/drive/folder";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import {
  createEmptyLateralDataProcessingSetup,
  withLateralDataProcessingDefaults,
  type LateralDataProcessingSetup,
  type LateralDataProcessingValidationResult,
  type ProcessingDriveFolderConfig,
  type WorkbookOption,
} from "@/types/lateral-processing-setup";

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

export function resolveProcessingFolderId(
  input: ProcessingDriveFolderConfig
): string {
  if (input.folderId.trim()) return input.folderId.trim();
  if (input.folderUrl.trim()) {
    const parsed = parseDriveFolderIdFromUrl(input.folderUrl.trim());
    if (parsed) return parsed;
  }
  return "";
}

function resolveFolderId(input: ProcessingDriveFolderConfig): string {
  return resolveProcessingFolderId(input);
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

async function downloadDriveFileToTemp(fileId: string, nameHint: string): Promise<string> {
  const { drive } = await getAuthorizedGmailClient();
  const safeName = (nameHint || fileId).replace(/[^\w.-]+/g, "_");
  const tempPath = path.join(os.tmpdir(), `lateral-setup-${Date.now()}-${safeName}`);
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

  return rows.sort((a, b) => (b.modifiedTime || "").localeCompare(a.modifiedTime || ""));
}

export async function listDriveExcelWorkbooksByName(
  query: string
): Promise<WorkbookOption[]> {
  const { drive } = await getAuthorizedGmailClient();
  const q = query.trim().replace(/'/g, "\\'");
  if (!q) return [];

  // Prefer corpora=user so "Shared with me" files are included.
  // corpora=allDrives alone often misses Shared-with-me (non shared-drive) files.
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

  // If the full title is too specific, retry with a shorter distinctive fragment
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

export function validateLateralDataProcessingInput(
  body: unknown
): { ok: true; config: LateralDataProcessingSetup } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Invalid setup payload." };
  }
  const draft = withLateralDataProcessingDefaults(
    body as Record<string, unknown>
  );
  const empty = createEmptyLateralDataProcessingSetup();

  const sourceFolderId = resolveFolderId(draft.sourceFolder);
  if (!sourceFolderId) {
    return { ok: false, error: "Source data location is required." };
  }
  if (!draft.sourceWorkbook.fileId.trim()) {
    return { ok: false, error: "Select a source workbook to process." };
  }
  if (!draft.sourceWorksheet.trim()) {
    return { ok: false, error: "Source worksheet is required." };
  }
  if (!draft.masterWorkbook.fileId.trim()) {
    return { ok: false, error: "Select the master workbook to update." };
  }
  if (!draft.masterNewSheet.trim()) {
    return { ok: false, error: "Master New Sheet name is required." };
  }
  if (!draft.masterSheet.trim()) {
    return { ok: false, error: "Master Sheet name is required." };
  }
  const destinationFolderId = resolveFolderId(draft.destinationFolder);
  if (!destinationFolderId) {
    return { ok: false, error: "Google Drive destination folder is required." };
  }
  const enabledKeywords = draft.keywords.filter(
    (keyword) => keyword.enabled && keyword.value.trim()
  );
  if (enabledKeywords.length === 0) {
    return {
      ok: false,
      error: "Add at least one enabled Gmail search keyword for Lateral.",
    };
  }
  if (!draft.timezone.trim()) {
    return { ok: false, error: "Time zone is required." };
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: draft.timezone }).format(
      new Date()
    );
  } catch {
    return { ok: false, error: `Invalid time zone: ${draft.timezone}` };
  }
  if (draft.schedule.frequency === "custom") {
    if (!draft.schedule.customDays?.length) {
      return {
        ok: false,
        error: "Custom schedule needs at least one day selected.",
      };
    }
    if (
      !draft.schedule.customTimes?.length ||
      draft.schedule.customTimes.some(
        (time) => !/^\d{1,2}:\d{2}$/.test(String(time).trim())
      )
    ) {
      return {
        ok: false,
        error: "Custom schedule needs at least one valid time (HH:MM).",
      };
    }
  } else if (
    draft.schedule.frequency !== "hourly" &&
    !/^\d{1,2}:\d{2}$/.test(draft.schedule.syncTime.trim())
  ) {
    return { ok: false, error: "Enter a valid schedule time (HH:MM)." };
  }

  return {
    ok: true,
    config: {
      ...empty,
      ...draft,
      updatedAt: new Date().toISOString(),
      sourceFolder: {
        ...draft.sourceFolder,
        folderId: sourceFolderId,
      },
      destinationFolder: {
        ...draft.destinationFolder,
        folderId: destinationFolderId,
      },
      keywords: draft.keywords,
      schedule: draft.schedule,
      timezone: draft.timezone,
    },
  };
}

export async function validateLateralDataProcessingConfig(
  config: LateralDataProcessingSetup
): Promise<LateralDataProcessingValidationResult> {
  const { drive } = await getAuthorizedGmailClient();
  const sourceFolderId = resolveFolderId(config.sourceFolder);
  const destinationFolderId = resolveFolderId(config.destinationFolder);
  const result: LateralDataProcessingValidationResult = {
    sourceFolder: { ok: false, message: "Not checked" },
    sourceWorkbook: { ok: false, message: "Not checked" },
    sourceWorksheet: { ok: false, message: "Not checked" },
    masterWorkbook: { ok: false, message: "Not checked" },
    masterNewSheet: { ok: false, message: "Not checked" },
    masterSheet: { ok: false, message: "Not checked" },
    destinationFolder: { ok: false, message: "Not checked" },
  };

  const folderCheck = async (folderId: string, label: "sourceFolder" | "destinationFolder") => {
    try {
      const folder = await drive.files.get({
        fileId: folderId,
        fields: "id,name,mimeType",
        supportsAllDrives: true,
      });
      if (folder.data.mimeType !== "application/vnd.google-apps.folder") {
        result[label] = { ok: false, message: "ID exists but is not a folder." };
        return;
      }
      result[label] = { ok: true, message: `${folder.data.name} (${folder.data.id})` };
    } catch (error) {
      result[label] = {
        ok: false,
        message: error instanceof Error ? error.message : "Folder not accessible.",
      };
    }
  };

  await Promise.all([
    folderCheck(sourceFolderId, "sourceFolder"),
    folderCheck(destinationFolderId, "destinationFolder"),
  ]);

  let sourceWorkbookParentsOk = false;
  try {
    const sourceMeta = await drive.files.get({
      fileId: config.sourceWorkbook.fileId,
      fields: "id,name,mimeType,parents",
      supportsAllDrives: true,
    });
    const parents = sourceMeta.data.parents ?? [];
    sourceWorkbookParentsOk = parents.includes(sourceFolderId);
    if (!sourceWorkbookParentsOk) {
      result.sourceWorkbook = {
        ok: false,
        message: "Workbook found, but it is not inside the configured source folder.",
      };
    } else {
      result.sourceWorkbook = {
        ok: true,
        message: `${sourceMeta.data.name} (${sourceMeta.data.id})`,
      };
    }
  } catch (error) {
    result.sourceWorkbook = {
      ok: false,
      message: error instanceof Error ? error.message : "Source workbook not accessible.",
    };
  }

  let sourceSheets: string[] = [];
  if (result.sourceWorkbook.ok && sourceWorkbookParentsOk) {
    try {
      sourceSheets = await listWorkbookWorksheets(
        config.sourceWorkbook.fileId,
        config.sourceWorkbook.fileName
      );
      result.sourceWorksheet = sourceSheets.includes(config.sourceWorksheet)
        ? { ok: true, message: `Found worksheet "${config.sourceWorksheet}".` }
        : {
            ok: false,
            message: `Worksheet "${config.sourceWorksheet}" not found. Available: ${sourceSheets.join(", ")}`,
          };
    } catch (error) {
      result.sourceWorksheet = {
        ok: false,
        message:
          error instanceof Error
            ? `Unable to inspect source workbook: ${error.message}`
            : "Unable to inspect source workbook.",
      };
    }
  }

  let masterSheets: string[] = [];
  try {
    const masterMeta = await drive.files.get({
      fileId: config.masterWorkbook.fileId,
      fields: "id,name,mimeType",
      supportsAllDrives: true,
    });
    result.masterWorkbook = {
      ok: true,
      message: `${masterMeta.data.name} (${masterMeta.data.id})`,
    };
    masterSheets = await listWorkbookWorksheets(
      config.masterWorkbook.fileId,
      config.masterWorkbook.fileName
    );
  } catch (error) {
    result.masterWorkbook = {
      ok: false,
      message: error instanceof Error ? error.message : "Master workbook not accessible.",
    };
  }

  if (result.masterWorkbook.ok) {
    result.masterNewSheet = masterSheets.includes(config.masterNewSheet)
      ? { ok: true, message: `Found worksheet "${config.masterNewSheet}".` }
      : {
          ok: false,
          message: `Worksheet "${config.masterNewSheet}" not found. Available: ${masterSheets.join(", ")}`,
        };
    result.masterSheet = masterSheets.includes(config.masterSheet)
      ? { ok: true, message: `Found worksheet "${config.masterSheet}".` }
      : {
          ok: false,
          message: `Worksheet "${config.masterSheet}" not found. Available: ${masterSheets.join(", ")}`,
        };
  }

  return result;
}

