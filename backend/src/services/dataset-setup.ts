/**
 * Stage 16/21: dataset setup — matches Next secure-store.ts and setup route.
 */
import {
  deleteEncryptedJson,
  getEncryptedStorePathForDiagnostics,
  readEncryptedJson,
  writeEncryptedJson,
} from "./encrypted-json-store.js";
import { validateDatasetSetupInput } from "./dataset-validate-setup.js";
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

export async function writeDatasetSetup(
  config: DatasetSetupConfig
): Promise<void> {
  await writeEncryptedJson(SETUP_FILE, config);
}

export async function clearDatasetSetup(): Promise<void> {
  await deleteEncryptedJson(SETUP_FILE);
}

export function getDatasetSetupStorePath(): string {
  return getEncryptedStorePathForDiagnostics(SETUP_FILE);
}

export type DatasetSetupGetResponse = {
  configured: boolean;
  updatedAt: string | null;
  setup: (Omit<DatasetSetupConfig, "updatedAt"> & { updatedAt: string }) | null;
};

export type DatasetSetupPostResponse = {
  configured: true;
  updatedAt: string;
  setup: DatasetSetupConfig;
  scheduler: null;
  requiresReauth: {
    gmail: boolean;
    drive: boolean;
  };
  message: string;
};

export type DatasetSetupDeleteResponse = {
  configured: false;
  setup: null;
  scheduler: null;
  message: string;
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

export async function postDatasetSetup(
  body: unknown
): Promise<
  | { ok: true; payload: DatasetSetupPostResponse }
  | { ok: false; status: 400; error: string; requiresReauth?: { gmail: boolean; drive: true } }
> {
  const previous = await readDatasetSetup();
  const validated = validateDatasetSetupInput(body);
  if (!validated.ok) {
    return { ok: false, status: 400, error: validated.error };
  }

  const next = validated.config;
  const gmailChanged = Boolean(
    previous &&
      previous.gmailAddress.toLowerCase() !== next.gmailAddress.toLowerCase()
  );
  const driveChanged = Boolean(
    previous &&
      previous.driveAccountEmail.toLowerCase() !==
        next.driveAccountEmail.toLowerCase()
  );

  if (
    previous &&
    !driveChanged &&
    previous.driveAuthStatus === "authenticated"
  ) {
    next.driveAuthStatus = "authenticated";
  }

  if (next.driveAuthStatus !== "authenticated") {
    return {
      ok: false,
      status: 400,
      error: driveChanged
        ? "Google Drive account changed. Re-authenticate Drive before saving."
        : "Authenticate the Google Drive account before saving.",
      requiresReauth: { gmail: gmailChanged, drive: true },
    };
  }

  await writeDatasetSetup(next);

  return {
    ok: true,
    payload: {
      configured: true,
      updatedAt: next.updatedAt,
      setup: next,
      scheduler: null,
      requiresReauth: {
        gmail: gmailChanged,
        drive: driveChanged,
      },
      message:
        gmailChanged || driveChanged
          ? "Configuration saved. Reconnect OAuth for the changed account(s)."
          : "Configuration saved. Automation reloaded immediately.",
    },
  };
}

export async function deleteDatasetSetup(): Promise<DatasetSetupDeleteResponse> {
  await clearDatasetSetup();
  return {
    configured: false,
    setup: null,
    scheduler: null,
    message: "Dataset configuration reset.",
  };
}
