/**
 * Stage 24: read-only lateral processing setup store.
 */
import { readEncryptedJson } from "./encrypted-json-store.js";
import {
  withLateralDataProcessingDefaults,
  type LateralDataProcessingSetup,
} from "../types/lateral-processing-setup.js";

const STORE_FILE = "lateral-data-processing-setup.enc.json";

export async function readLateralDataProcessingSetup(): Promise<LateralDataProcessingSetup | null> {
  const raw = await readEncryptedJson<LateralDataProcessingSetup>(STORE_FILE);
  if (!raw) return null;
  return {
    ...withLateralDataProcessingDefaults(raw),
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
}
