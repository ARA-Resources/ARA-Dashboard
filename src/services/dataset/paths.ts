import path from "node:path";
import type { DatasetSyncName } from "@/types/dataset-sync";
import { DATASET_SYNC_NAMES } from "@/types/dataset-sync";

export const DATASET_ROOT = path.join(process.cwd(), ".data", "datasets");
export const DATASET_TEMP_DIR = path.join(DATASET_ROOT, "temp");
export const DATASET_CURRENT_DIR = path.join(DATASET_ROOT, "current");
export const DATASET_VERSIONS_DIR = path.join(DATASET_ROOT, "versions");
export const DATASET_LOG_DIR = path.join(process.cwd(), ".data", "logs");

export function datasetCurrentDir(name: DatasetSyncName | string) {
  return path.join(DATASET_CURRENT_DIR, sanitizeDatasetName(name));
}

export function datasetVersionsDir(name: DatasetSyncName | string) {
  return path.join(DATASET_VERSIONS_DIR, sanitizeDatasetName(name));
}

export function sanitizeDatasetName(name: string) {
  return name.replace(/[^\w.-]+/g, "_");
}

/**
 * Keep the Gmail attachment's original Excel name for Dataset Manager + Drive.
 * Only strips characters illegal on Windows/macOS paths so Excel 365 can open
 * the same workbook users received by email.
 */
export function buildDatasetSaveFilename(originalFilename: string): string {
  const base = path.basename(originalFilename || "").trim() || "workbook.xlsx";
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim();
  if (!cleaned) return "workbook.xlsx";
  if (!/\.(xlsx|xlsm|xls)$/i.test(cleaned)) {
    return `${cleaned}.xlsx`;
  }
  return cleaned;
}

/**
 * @deprecated Prefer {@link buildDatasetSaveFilename} (original attachment name).
 * Kept for older call sites; now returns the original Excel filename.
 */
export function buildRenamedDatasetFilename(
  _datasetName: string,
  _when: Date,
  originalFilename: string
) {
  return buildDatasetSaveFilename(originalFilename);
}

export function resolveDatasetNameFromAttachment(
  attachmentName: string,
  patterns: string[]
): DatasetSyncName | null {
  const lower = attachmentName.toLowerCase();

  for (const name of DATASET_SYNC_NAMES) {
    if (lower.includes(name.toLowerCase())) return name;
  }

  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    for (const name of DATASET_SYNC_NAMES) {
      if (p.includes(name.toLowerCase()) && lower.includes(name.toLowerCase())) {
        return name;
      }
      // Pattern like "ATCI Lateral" matched via includes on filename already handled;
      // also map if pattern matches and contains dataset token only.
      if (p.includes(name.toLowerCase()) && filenameMatchesLoose(lower, p)) {
        return name;
      }
    }
  }

  return null;
}

function filenameMatchesLoose(filename: string, pattern: string) {
  if (pattern.includes("*")) {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(escaped, "i").test(filename);
  }
  return filename.includes(pattern.replace(/\s+/g, " ").trim());
}
