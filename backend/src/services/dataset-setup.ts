/**
 * Stage 16: read-only dataset setup — matches Next secure-store.ts GET path.
 */
import {
  getEncryptedStorePathForDiagnostics,
  readEncryptedJson,
} from "./encrypted-json-store.js";
import {
  withSetupDefaults,
  type DatasetSetupConfig,
} from "../types/dataset-setup.js";

const SETUP_FILE = "dataset-setup.enc.json";

export async function readDatasetSetup(): Promise<DatasetSetupConfig | null> {
  const raw = await readEncryptedJson<DatasetSetupConfig>(SETUP_FILE);
  if (!raw) return null;
  return {
    ...withSetupDefaults(raw),
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
}

export function getDatasetSetupStorePath(): string {
  return getEncryptedStorePathForDiagnostics(SETUP_FILE);
}

export type DatasetSetupGetResponse = {
  configured: boolean;
  updatedAt: string | null;
  setup: (Omit<DatasetSetupConfig, "updatedAt"> & { updatedAt: string }) | null;
};

/** Build GET response matching Next route handler. */
export async function getDatasetSetupResponse(): Promise<DatasetSetupGetResponse> {
  const setup = await readDatasetSetup();
  const normalized = setup
    ? { ...withSetupDefaults(setup), updatedAt: setup.updatedAt }
    : null;
  return {
    configured: Boolean(setup),
    updatedAt: setup?.updatedAt ?? null,
    setup: normalized,
  };
}
