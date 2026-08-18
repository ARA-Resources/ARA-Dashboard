import fs from "node:fs/promises";
import path from "node:path";
import { getBusinessUnitById } from "@/constants/business-units";
import { getLateralExcelPath } from "@/lib/config/runtime";
import {
  buildDatasetSaveFilename,
  datasetCurrentDir,
} from "@/services/dataset/paths";
import {
  businessUnitToDatasetName,
  resolveCurrentDatasetFile,
  type CurrentDatasetFile,
} from "@/services/dataset/resolve-current";
import type { BusinessUnitId } from "@/types/business-unit";
import type { DatasetSyncName } from "@/types/dataset-sync";

/**
 * One-time bootstrap sources used ONLY to populate Dataset Manager.
 * Company / dashboard code must never read these paths directly.
 */
function legacyBootstrapCandidates(businessUnitId: BusinessUnitId): string[] {
  const unit = getBusinessUnitById(businessUnitId);
  if (!unit) return [];

  const candidates: string[] = [];
  const configuredPath = getLateralExcelPath();
  if (businessUnitId === "lateral" && configuredPath) {
    candidates.push(configuredPath);
  }
  candidates.push(path.join(/* turbopackIgnore: true */ process.cwd(), unit.excel.relativePath));
  candidates.push(path.join(/* turbopackIgnore: true */ process.cwd(), "data", "excel", unit.excel.fileName));
  return candidates;
}

async function firstReadable(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Ensures Dataset Manager has a current workbook for the business unit.
 * If missing, copies from a legacy bootstrap path into
 * `.data/datasets/current/{DatasetName}/` once.
 */
export async function ensureCurrentDataset(
  businessUnitId: BusinessUnitId
): Promise<CurrentDatasetFile> {
  const datasetName = businessUnitToDatasetName(businessUnitId);
  const existing = await resolveCurrentDatasetFile(datasetName);
  if (existing) return existing;

  const seeded = await seedCurrentDatasetFromLegacy(datasetName, businessUnitId);
  if (seeded) return seeded;

  throw new Error(
    `No synchronized dataset for ${datasetName}. ` +
      `Open Dataset Manager and sync the latest ${datasetName} Excel file.`
  );
}

export async function seedCurrentDatasetFromLegacy(
  datasetName: DatasetSyncName,
  businessUnitId: BusinessUnitId
): Promise<CurrentDatasetFile | null> {
  const sourcePath = await firstReadable(legacyBootstrapCandidates(businessUnitId));
  if (!sourcePath) return null;

  const currentDir = datasetCurrentDir(datasetName);
  await fs.mkdir(currentDir, { recursive: true });

  const existing = await fs.readdir(currentDir);
  for (const file of existing) {
    if (/\.(xlsx|xlsm|xls)$/i.test(file)) {
      await fs.unlink(path.join(currentDir, file));
    }
  }

  const savedName = buildDatasetSaveFilename(path.basename(sourcePath));
  const destPath = path.join(currentDir, savedName);
  await fs.copyFile(sourcePath, destPath);

  const resolved = await resolveCurrentDatasetFile(datasetName);
  return resolved;
}

export async function ensureAllCurrentDatasets(): Promise<CurrentDatasetFile[]> {
  const ids: BusinessUnitId[] = ["lateral", "executive", "consulting"];
  const results: CurrentDatasetFile[] = [];
  for (const id of ids) {
    try {
      results.push(await ensureCurrentDataset(id));
    } catch {
      // Leave missing — dashboard will surface a clear error per unit
    }
  }
  return results;
}
