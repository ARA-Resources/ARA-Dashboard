import {
  readEncryptedJson,
  writeEncryptedJson,
} from "@/services/dataset/encrypted-json-store";
import type {
  DatasetDriveFileMeta,
  DatasetDriveMetaStore,
} from "@/types/drive-meta";

const META_FILE = "dataset-drive-meta.enc.json";

export async function readDriveMetaStore(): Promise<DatasetDriveMetaStore> {
  const stored = await readEncryptedJson<DatasetDriveMetaStore>(META_FILE);
  return (
    stored ?? {
      updatedAt: new Date().toISOString(),
      byDataset: {},
    }
  );
}

export async function getDatasetDriveMeta(
  datasetName: string
): Promise<DatasetDriveFileMeta | null> {
  const store = await readDriveMetaStore();
  return store.byDataset[datasetName] ?? null;
}

export async function upsertDatasetDriveMeta(
  meta: DatasetDriveFileMeta
): Promise<DatasetDriveMetaStore> {
  const store = await readDriveMetaStore();
  store.byDataset[meta.datasetName] = meta;
  store.updatedAt = new Date().toISOString();
  await writeEncryptedJson(META_FILE, store);
  return store;
}
