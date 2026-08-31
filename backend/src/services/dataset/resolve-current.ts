import fs from "node:fs/promises";
import path from "node:path";
import { datasetCurrentDir } from "./paths.js";
import {
  DATASET_SYNC_NAMES,
  type DatasetSyncName,
} from "../../types/dataset-sync.js";

const EXCEL_EXT = /\.(xlsx|xlsm|xls)$/i;

export type BusinessUnitId = "lateral" | "executive" | "consulting";

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
  businessUnitId: BusinessUnitId = "consulting"
): DatasetSyncName {
  return BUSINESS_UNIT_TO_DATASET[businessUnitId];
}

export function datasetNameToBusinessUnit(
  datasetName: DatasetSyncName
): BusinessUnitId {
  return DATASET_TO_BUSINESS_UNIT[datasetName];
}

export async function resolveCurrentDatasetFile(
  datasetName: DatasetSyncName | string = "Consulting"
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
