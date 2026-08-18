import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  DATASET_SYNC_NAMES,
  type DatasetSyncName,
} from "@/types/dataset-sync";
import {
  datasetCurrentDir,
  datasetVersionsDir,
} from "@/services/dataset/paths";
import { clearExcelCache } from "@/services/excel/reader";
import { clearSkillClusterCache } from "@/services/excel/extract-skill-clusters";
import { pushAppNotification } from "@/services/dataset/notifications-store";

const EXCEL_EXT = /\.(xlsx|xlsm|xls)$/i;

export interface DatasetVersionFile {
  datasetName: DatasetSyncName;
  fileName: string;
  filePath: string;
  mtimeMs: number;
  size: number;
  checksumSha256: string | null;
  updatedAt: string;
}

async function checksumFile(filePath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(filePath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

export async function listDatasetVersions(
  datasetName?: string
): Promise<DatasetVersionFile[]> {
  const names = datasetName
    ? DATASET_SYNC_NAMES.filter(
        (name) => name.toLowerCase() === datasetName.toLowerCase()
      )
    : [...DATASET_SYNC_NAMES];

  const results: DatasetVersionFile[] = [];

  for (const name of names) {
    const dir = datasetVersionsDir(name);
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }

    for (const fileName of files.filter((f) => EXCEL_EXT.test(f))) {
      const filePath = path.join(dir, fileName);
      try {
        const stat = await fs.stat(filePath);
        results.push({
          datasetName: name,
          fileName,
          filePath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          checksumSha256: await checksumFile(filePath),
          updatedAt: new Date(stat.mtimeMs).toISOString(),
        });
      } catch {
        // skip unreadable
      }
    }
  }

  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

/**
 * Restore a versioned workbook as the Dataset Manager current file.
 */
export async function rollbackDatasetVersion(input: {
  datasetName: string;
  fileName: string;
}): Promise<{ currentPath: string; datasetName: DatasetSyncName }> {
  const datasetName = DATASET_SYNC_NAMES.find(
    (name) => name.toLowerCase() === input.datasetName.toLowerCase()
  );
  if (!datasetName) {
    throw new Error(`Unknown dataset: ${input.datasetName}`);
  }

  const versionPath = path.join(
    datasetVersionsDir(datasetName),
    path.basename(input.fileName)
  );
  try {
    await fs.access(versionPath);
  } catch {
    throw new Error(
      `Version file not found for ${datasetName}: ${input.fileName}`
    );
  }

  const currentDir = datasetCurrentDir(datasetName);
  await fs.mkdir(currentDir, { recursive: true });

  // Archive current before overwrite
  const versionsDir = datasetVersionsDir(datasetName);
  await fs.mkdir(versionsDir, { recursive: true });
  try {
    const existing = await fs.readdir(currentDir);
    for (const file of existing.filter((f) => EXCEL_EXT.test(f))) {
      await fs.copyFile(
        path.join(currentDir, file),
        path.join(versionsDir, `pre-rollback_${Date.now()}_${file}`)
      );
      await fs.unlink(path.join(currentDir, file));
    }
  } catch {
    // no current yet
  }

  const nextCurrent = path.join(currentDir, path.basename(input.fileName));
  await fs.copyFile(versionPath, nextCurrent);

  clearExcelCache();
  clearSkillClusterCache();

  await pushAppNotification({
    kind: "dataset_sync_success",
    title: `${datasetName} dataset rolled back`,
    body: `Restored ${input.fileName} as the current ${datasetName} dataset.`,
    href: "/dataset",
    meta: { datasetName, fileName: input.fileName, action: "rollback" },
  });

  return { currentPath: nextCurrent, datasetName };
}
