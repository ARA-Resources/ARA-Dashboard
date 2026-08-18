import ExcelJS from "exceljs";
import { getLateralMasterDriveFileId } from "@/lib/config/runtime";
import { parseWorksheet } from "@/services/excel/parse-sheet";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import { readLateralDataProcessingSetup } from "@/services/lateral-processing/setup-store";
import {
  resolvePipelineMasterWorkbook,
  type ProcessingWorkbookConfig,
} from "@/types/lateral-processing-setup";
import type { ExcelReadResult } from "@/types/excel";

interface DriveXlsmCacheEntry {
  mtimeMs: number;
  payload: ExcelReadResult;
}

const memoryCache = new Map<string, DriveXlsmCacheEntry>();

function driveFileViewUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId.trim()}/view`;
}

async function resolveLateralMasterDriveXlsm(): Promise<ProcessingWorkbookConfig> {
  try {
    const setup = await readLateralDataProcessingSetup();
    if (setup) {
      const pipeline = resolvePipelineMasterWorkbook(setup);
      if (pipeline.fileId.trim()) return pipeline;
    }
  } catch {
    // fall through to canonical Drive file id
  }
  return {
    fileId: getLateralMasterDriveFileId(),
    fileName: "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm",
  };
}

/**
 * Vercel-safe Master reader for P-Roles:
 * - Google Drive remains source of truth
 * - reads XLSM directly with ExcelJS from in-memory buffer
 * - no Python, no child_process, no local filesystem writes
 */
export async function readLateralMasterSheetFromDriveXlsmVercelSafe(options: {
  sheetName: string;
  headerRow?: number;
  bypassCache?: boolean;
}): Promise<ExcelReadResult> {
  const workbookRef = await resolveLateralMasterDriveXlsm();
  const fileId = workbookRef.fileId.trim() || getLateralMasterDriveFileId();
  const { drive } = await getAuthorizedGmailClient();

  const meta = await drive.files.get({
    fileId,
    fields: "id,name,mimeType,trashed,modifiedTime,webViewLink",
    supportsAllDrives: true,
  });

  if (!meta.data.id) {
    throw new Error(
      `Configured Master Workbook was not found on Google Drive (id=${fileId}).`
    );
  }
  if (meta.data.trashed) {
    throw new Error(
      `Configured Master Workbook is in trash on Google Drive (id=${fileId}). Restore it before reading P-Roles.`
    );
  }

  const fileName =
    meta.data.name ||
    workbookRef.fileName ||
    "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm";
  const mtimeMs = meta.data.modifiedTime
    ? Date.parse(meta.data.modifiedTime)
    : Date.now();
  const cacheKey = `${fileId}:${options.sheetName}:${options.headerRow ?? 1}`;
  const cached = memoryCache.get(cacheKey);

  if (cached && cached.mtimeMs === mtimeMs && !options.bypassCache) {
    return cached.payload;
  }

  const blob = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );

  const excel = new ExcelJS.Workbook();
  await excel.xlsx.load(
    Buffer.from(blob.data as ArrayBuffer) as unknown as Parameters<
      ExcelJS.Xlsx["load"]
    >[0]
  );

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
