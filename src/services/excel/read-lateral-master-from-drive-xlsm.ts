/**
 * Read Company → Accenture → Lateral → Master Sheet from the Drive XLSM.
 * Never creates a substitute workbook. Restores the configured file from trash if needed.
 */
import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { parseWorksheet } from "@/services/excel/parse-sheet";
import { resolveReadableExcelPath } from "@/services/excel/readable-workbook";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import { readLateralDataProcessingSetup } from "@/services/lateral-processing/setup-store";
import {
  resolvePipelineMasterWorkbook,
  type ProcessingWorkbookConfig,
} from "@/types/lateral-processing-setup";
import type { ExcelReadResult, ExcelReaderOptions } from "@/types/excel";

import { getLateralMasterDriveFileId, getLateralMasterDriveViewUrl } from "@/lib/config/runtime";

export function getLateralProcessingMasterDriveFileId(): string {
  return getLateralMasterDriveFileId();
}

export function getLateralProcessingMasterDriveUrl(): string {
  return getLateralMasterDriveViewUrl();
}

const CACHE_DIR = path.join(process.cwd(), ".data", "excel-cache", "drive-xlsm");

interface DriveXlsmCacheEntry {
  mtimeMs: number;
  payload: ExcelReadResult;
}

const memoryCache = new Map<string, DriveXlsmCacheEntry>();

export function driveFileViewUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId.trim()}/view`;
}

export async function resolveLateralMasterDriveXlsm(): Promise<ProcessingWorkbookConfig> {
  try {
    const setup = await readLateralDataProcessingSetup();
    if (setup) {
      const pipeline = resolvePipelineMasterWorkbook(setup);
      if (pipeline.fileId.trim()) return pipeline;
    }
  } catch {
    // fall through to canonical Drive file
  }
  return {
    fileId: getLateralProcessingMasterDriveFileId(),
    fileName: "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm",
  };
}

async function ensureLocalXlsm(options: {
  fileId: string;
  fileName: string;
  modifiedTime: string | null;
  bypassCache?: boolean;
}): Promise<string> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const localPath = path.join(CACHE_DIR, `${options.fileId}.xlsm`);
  const stampPath = path.join(CACHE_DIR, `${options.fileId}.mtime`);
  const stamp = options.modifiedTime || "";

  if (!options.bypassCache) {
    try {
      const [stat, previous] = await Promise.all([
        fs.stat(localPath),
        fs.readFile(stampPath, "utf8").catch(() => ""),
      ]);
      if (stat.size > 0 && previous.trim() === stamp && stamp) {
        return localPath;
      }
    } catch {
      // download below
    }
  }

  const { drive } = await getAuthorizedGmailClient();
  const response = await drive.files.get(
    { fileId: options.fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(localPath, Buffer.from(response.data as ArrayBuffer));
  await fs.writeFile(stampPath, stamp, "utf8");
  return localPath;
}

export async function readLateralMasterSheetFromDriveXlsm(options: {
  sheetName: string;
  headerRow?: number;
  readerOptions?: ExcelReaderOptions;
}): Promise<ExcelReadResult> {
  const workbook = await resolveLateralMasterDriveXlsm();
  const fileId = workbook.fileId.trim() || getLateralProcessingMasterDriveFileId();
  const { drive } = await getAuthorizedGmailClient();

  let meta = await drive.files.get({
    fileId,
    fields: "id,name,mimeType,trashed,modifiedTime,webViewLink",
    supportsAllDrives: true,
  });

  if (meta.data.trashed) {
    meta = await drive.files.update({
      fileId,
      requestBody: { trashed: false },
      fields: "id,name,mimeType,trashed,modifiedTime,webViewLink",
      supportsAllDrives: true,
    });
  }

  if (!meta.data.id) {
    throw new Error(
      `Configured Master Workbook was not found on Google Drive (id=${fileId}).`
    );
  }

  const fileName =
    meta.data.name ||
    workbook.fileName ||
    "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm";
  const mtimeMs = meta.data.modifiedTime
    ? Date.parse(meta.data.modifiedTime)
    : Date.now();
  const cacheKey = `${fileId}:${options.sheetName}:${options.headerRow ?? 1}`;
  const cached = memoryCache.get(cacheKey);
  if (
    cached &&
    cached.mtimeMs === mtimeMs &&
    !options.readerOptions?.bypassCache
  ) {
    return cached.payload;
  }

  const localPath = await ensureLocalXlsm({
    fileId,
    fileName,
    modifiedTime: meta.data.modifiedTime ?? null,
    bypassCache: options.readerOptions?.bypassCache,
  });
  const readablePath = await resolveReadableExcelPath(localPath);
  const excel = new ExcelJS.Workbook();
  await excel.xlsx.readFile(readablePath);
  const sheet =
    excel.worksheets.find(
      (item) =>
        item.name.trim().toLowerCase() === options.sheetName.trim().toLowerCase()
    ) ?? null;

  if (!sheet) {
    const available = excel.worksheets.map((item) => item.name).join(", ");
    throw new Error(
      `Sheet "${options.sheetName}" not found in Drive Master Workbook ${fileName}. Available: ${available}`
    );
  }

  const parsed = parseWorksheet(sheet, { headerRow: options.headerRow ?? 1 });
  const viewUrl = meta.data.webViewLink || driveFileViewUrl(fileId);

  const payload: ExcelReadResult = {
    businessUnitId: "lateral",
    sheetName: parsed.sheetName,
    sourceFile: fileName,
    sourceLabel: `Google Drive XLSM · ${fileName}`,
    headers: parsed.headers,
    rows: parsed.rows.map((row, index) => ({
      id: `drive-xlsm-${parsed.sheetName}-${index + 1}`,
      ...row,
    })),
    meta: {
      name: parsed.sheetName,
      rowCount: parsed.rows.length,
      columnCount: parsed.headers.length,
      headerRow: parsed.headerRow,
      filePath: viewUrl,
      mtimeMs,
      totalRows: parsed.rows.length,
    },
  };

  memoryCache.set(cacheKey, { mtimeMs, payload });
  return payload;
}
