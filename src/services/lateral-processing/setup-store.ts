import {
  deleteEncryptedJson,
  readEncryptedJson,
  writeEncryptedJson,
} from "@/services/dataset/encrypted-json-store";
import {
  withLateralDataProcessingDefaults,
  type LateralDataProcessingSetup,
} from "@/types/lateral-processing-setup";

const STORE_FILE = "lateral-data-processing-setup.enc.json";

export async function readLateralDataProcessingSetup(): Promise<LateralDataProcessingSetup | null> {
  const raw = await readEncryptedJson<LateralDataProcessingSetup>(STORE_FILE);
  if (!raw) return null;
  return {
    ...withLateralDataProcessingDefaults(raw),
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
}

export async function writeLateralDataProcessingSetup(
  setup: LateralDataProcessingSetup
): Promise<void> {
  await writeEncryptedJson(STORE_FILE, setup);
}

export async function clearLateralDataProcessingSetup(): Promise<void> {
  await deleteEncryptedJson(STORE_FILE);
}
