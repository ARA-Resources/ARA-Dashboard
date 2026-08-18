import {
  deleteEncryptedJson,
  readEncryptedJson,
  writeEncryptedJson,
} from "@/services/dataset/encrypted-json-store";
import {
  withSetupDefaults,
  type DatasetSetupConfig,
} from "@/types/dataset-setup";

const SETUP_FILE = "dataset-setup.enc.json";

export async function readDatasetSetup(): Promise<DatasetSetupConfig | null> {
  const raw = await readEncryptedJson<DatasetSetupConfig>(SETUP_FILE);
  if (!raw) return null;
  return {
    ...withSetupDefaults(raw),
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
}

export async function writeDatasetSetup(
  config: DatasetSetupConfig
): Promise<void> {
  await writeEncryptedJson(SETUP_FILE, config);
}

export async function clearDatasetSetup(): Promise<void> {
  await deleteEncryptedJson(SETUP_FILE);
}
