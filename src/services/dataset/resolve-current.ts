import fs from "node:fs/promises";
import path from "node:path";
import { datasetCurrentDir } from "@/services/dataset/paths";
import type { BusinessUnitId } from "@/types/business-unit";
import {
  DATASET_SYNC_NAMES,
  type DatasetSyncName,
} from "@/types/dataset-sync";

const EXCEL_EXT = /\.(xlsx|xlsm|xls)$/i;

const BUSINESS_UNIT_TO_DATASET: Record<BusinessUnitId, DatasetSyncName> = {
  lateral: "Lateral",
  executive: "Executive",
  consulting: "Consulting",
};

const DATASET_TO_BUSINESS_UNIT: Record<DatasetSyncName, BusinessUnitId> = {
  Lateral: "lateral",
  Executive: "executive",
  Consulting: "consulting",
};

export interface CurrentDatasetFile {
  datasetName: DatasetSyncName;
  businessUnitId: BusinessUnitId;
  filePath: string;
  fileName: string;
  mtimeMs: number;
  size: number;
  source: "dataset-manager";
}

export function businessUnitToDatasetName(
  businessUnitId: BusinessUnitId
): DatasetSyncName {
  return BUSINESS_UNIT_TO_DATASET[businessUnitId];
}

export function datasetNameToBusinessUnit(
  datasetName: DatasetSyncName
): BusinessUnitId {
  return DATASET_TO_BUSINESS_UNIT[datasetName];
}

/**
 * Latest synchronized workbook for a Dataset Manager dataset.
 * Picks the newest Excel by mtime under `.data/datasets/current/{Name}/`.
 */
export async function resolveCurrentDatasetFile(
  datasetName: DatasetSyncName | string
): Promise<CurrentDatasetFile | null> {
  const normalized = DATASET_SYNC_NAMES.find(
    (name) => name.toLowerCase() === String(datasetName).toLowerCase()
  );
  if (!normalized) return null;

  const dir = datasetCurrentDir(normalized);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  const excelNames = entries.filter((name) => EXCEL_EXT.test(name));
  if (excelNames.length === 0) return null;

  const scored = await Promise.all(
    excelNames.map(async (fileName) => {
      const filePath = path.join(dir, fileName);
      const stat = await fs.stat(filePath);
      return {
        datasetName: normalized,
        businessUnitId: datasetNameToBusinessUnit(normalized),
        filePath,
        fileName,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        source: "dataset-manager" as const,
      };
    })
  );

  scored.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return scored[0] ?? null;
}

export async function resolveCurrentDatasetForBusinessUnit(
  businessUnitId: BusinessUnitId
): Promise<CurrentDatasetFile | null> {
  return resolveCurrentDatasetFile(businessUnitToDatasetName(businessUnitId));
}

export async function listCurrentDatasetFiles(): Promise<CurrentDatasetFile[]> {
  const results: CurrentDatasetFile[] = [];
  for (const name of DATASET_SYNC_NAMES) {
    const current = await resolveCurrentDatasetFile(name);
    if (current) results.push(current);
  }
  return results;
}
