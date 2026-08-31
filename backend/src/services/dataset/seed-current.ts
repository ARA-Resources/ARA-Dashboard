import fs from "node:fs/promises";
import path from "node:path";
import { resolveRepoRoot } from "../../config/repo-root.js";
import { CONSULTING_EXCEL_SOURCE } from "../../constants/consulting.js";
import {
  buildDatasetSaveFilename,
  datasetCurrentDir,
} from "./paths.js";
import {
  businessUnitToDatasetName,
  resolveCurrentDatasetFile,
  type CurrentDatasetFile,
} from "./resolve-current.js";

function legacyBootstrapCandidates(): string[] {
  const root = resolveRepoRoot();
  return [
    path.join(root, CONSULTING_EXCEL_SOURCE.relativePath),
    path.join(root, "data", "excel", CONSULTING_EXCEL_SOURCE.fileName),
  ];
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
 * Ensures Dataset Manager has a current Consulting workbook.
 * If missing, copies from a legacy bootstrap path once (matches Next behavior).
 */
export async function ensureConsultingDataset(): Promise<CurrentDatasetFile> {
  const datasetName = businessUnitToDatasetName();
  const existing = await resolveCurrentDatasetFile(datasetName);
  if (existing) return existing;

  const seeded = await seedConsultingDatasetFromLegacy();
  if (seeded) return seeded;

  throw new Error(
    `No synchronized dataset for ${datasetName}. ` +
      `Open Dataset Manager and sync the latest ${datasetName} Excel file.`
  );
}

async function seedConsultingDatasetFromLegacy(): Promise<CurrentDatasetFile | null> {
  const sourcePath = await firstReadable(legacyBootstrapCandidates());
  if (!sourcePath) return null;

  const datasetName = businessUnitToDatasetName();
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

  return resolveCurrentDatasetFile(datasetName);
}
