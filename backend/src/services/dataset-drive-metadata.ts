/**
 * Stage 18: read-only Drive metadata — matches Next metadata-store.ts GET path.
 * Does NOT call Google Drive or OAuth.
 */
import {
  getEncryptedStorePathForDiagnostics,
  readEncryptedJson,
} from "./encrypted-json-store.js";
import type { DatasetDriveMetaStore } from "../types/dataset-drive-metadata.js";

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

export function getDriveMetaStorePath(): string {
  return getEncryptedStorePathForDiagnostics(META_FILE);
}
