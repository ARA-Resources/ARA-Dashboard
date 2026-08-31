import fs from "node:fs/promises";
import path from "node:path";
import { repoDataDir } from "../config/repo-root.js";
import {
  DATASET_SYNC_NAMES,
  type DatasetSyncName,
} from "../types/dataset-sync.js";
import type { BusinessUnitId } from "../types/home-widgets.js";
import type {
  CurrentDatasetFile,
  DatasetCurrentGetResponse,
} from "../types/dataset-current.js";

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

function datasetRootDir(): string {
  return path.join(repoDataDir(), "datasets");
}

function datasetCurrentDir(name: DatasetSyncName | string): string {
  const sanitized = String(name).replace(/[^\w.-]+/g, "_");
  return path.join(datasetRootDir(), "current", sanitized);
}

function businessUnitToDatasetName(
  businessUnitId: BusinessUnitId
): DatasetSyncName {
  return BUSINESS_UNIT_TO_DATASET[businessUnitId];
}

function datasetNameToBusinessUnit(
  datasetName: DatasetSyncName
): BusinessUnitId {
  return DATASET_TO_BUSINESS_UNIT[datasetName];
}

export function getDatasetCurrentRootDir(): string {
  return path.join(datasetRootDir(), "current");
}

async function resolveCurrentDatasetFile(
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

async function listCurrentDatasetFiles(): Promise<CurrentDatasetFile[]> {
  const results: CurrentDatasetFile[] = [];
  for (const name of DATASET_SYNC_NAMES) {
    const current = await resolveCurrentDatasetFile(name);
    if (current) results.push(current);
  }
  return results;
}

/** Read-only GET response — matches Next current route (without ?seed=1). */
export async function getDatasetCurrentResponse(): Promise<DatasetCurrentGetResponse> {
  const datasets = await listCurrentDatasetFiles();
  return {
    datasets: datasets.map((item) => ({
      datasetName: item.datasetName,
      businessUnitId: item.businessUnitId,
      fileName: item.fileName,
      filePath: item.filePath,
      mtimeMs: item.mtimeMs,
      size: item.size,
      source: item.source,
      updatedAt: new Date(item.mtimeMs).toISOString(),
    })),
  };
}

export async function resolveCurrentDatasetForBusinessUnit(
  businessUnitId: BusinessUnitId
): Promise<CurrentDatasetFile | null> {
  return resolveCurrentDatasetFile(businessUnitToDatasetName(businessUnitId));
}
