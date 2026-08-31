import path from "node:path";
import { repoDataDir } from "../../config/repo-root.js";
import type { DatasetSyncName } from "../../types/dataset-sync.js";

function datasetRootDir(): string {
  return path.join(repoDataDir(), "datasets");
}

export function datasetCurrentDir(name: DatasetSyncName | string): string {
  const sanitized = String(name).replace(/[^\w.-]+/g, "_");
  return path.join(datasetRootDir(), "current", sanitized);
}

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
